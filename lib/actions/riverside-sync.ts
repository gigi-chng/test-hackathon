"use server"

import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"
import {
  listProductions,
  listRecordings,
  downloadTranscript,
  RiversideAuthError,
  RiversideConfigError,
  type RiversideProduction,
  type RiversideRecording,
} from "@/lib/riverside"
import {
  detectSpeakers,
  resolveAliases,
  confirmTranscript,
} from "@/lib/actions/transcripts"
import { suggestPartner } from "@/lib/transcript-parse"

const PROJECTS_KEY = "RIVERSIDE_PROJECT_IDS"

// Which production is ours. Used only to pre-tick the picker on first load —
// the saved selection always wins after that.
const OURS = /\bslow\b/i

// ─── Which scopes to pull ────────────────────────────────────────────────────

/** A pullable scope, identified as "production:x" | "studio:y" | "project:z". */
export type ScopeChoice = {
  id: string
  label: string
  recordings: number
}

export type ProductionGroup = {
  id: string // "production:x"
  name: string
  recordings: number
  scopes: ScopeChoice[]
}

/**
 * Turn a production into the studio/project scopes the recordings endpoint can
 * actually filter by. A studio with no projects holds recordings directly, so
 * it becomes the scope itself.
 */
function scopesFor(prod: RiversideProduction): ScopeChoice[] {
  const scopes: ScopeChoice[] = []
  for (const studio of prod.studios ?? []) {
    if (!studio.projects?.length) {
      scopes.push({
        id: `studio:${studio.id}`,
        label: studio.name,
        recordings: studio.num_recordings,
      })
      continue
    }
    for (const project of studio.projects) {
      scopes.push({
        id: `project:${project.id}`,
        label: `${studio.name} / ${project.name}`,
        recordings: project.num_recordings,
      })
    }
  }
  return scopes
}

export async function listRiversideProjects(): Promise<
  | {
      ok: true
      productions: ProductionGroup[]
      selected: string[]
      /** Pre-tick suggestion for a first-time setup: our own production. */
      suggested: string[]
    }
  | { ok: false; reason: string }
> {
  try {
    const [productions, selected] = await Promise.all([
      listProductions(),
      getSelectedProjects(),
    ])

    const groups: ProductionGroup[] = productions.map(prod => ({
      id: `production:${prod.id}`,
      name: prod.name,
      recordings: prod.num_recordings,
      scopes: scopesFor(prod),
    }))

    return {
      ok: true,
      productions: groups,
      selected,
      suggested: groups.filter(g => OURS.test(g.name)).map(g => g.id),
    }
  } catch (err) {
    if (err instanceof RiversideConfigError) return { ok: false, reason: "NO_KEY" }
    if (err instanceof RiversideAuthError) return { ok: false, reason: "BAD_KEY" }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function getSelectedProjects(): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: PROJECTS_KEY } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === "string") : []
  } catch {
    return []
  }
}

export async function setSelectedProjects(ids: string[]): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_KEY },
    create: { key: PROJECTS_KEY, value: JSON.stringify(ids) },
    update: { value: JSON.stringify(ids) },
  })
  revalidatePath("/transcripts")
}

/**
 * Expand the saved selection into concrete studio/project filters.
 *
 * "production:x" is stored rather than its children on purpose: expanding it
 * at sync time means a new season added under that production starts syncing
 * on its own, which is the whole point of not doing this by hand.
 */
async function expandSelection(
  selected: string[]
): Promise<{ studioIds: string[]; projectIds: string[] }> {
  const studioIds: string[] = []
  const projectIds: string[] = []
  const productionIds: string[] = []

  for (const entry of selected) {
    const [kind, id] = entry.split(":")
    if (kind === "studio") studioIds.push(id)
    else if (kind === "project") projectIds.push(id)
    else if (kind === "production") productionIds.push(id)
  }

  if (productionIds.length > 0) {
    const productions = await listProductions()
    for (const prod of productions) {
      if (!productionIds.includes(prod.id)) continue
      for (const scope of scopesFor(prod)) {
        const [kind, id] = scope.id.split(":")
        if (kind === "studio") studioIds.push(id)
        else projectIds.push(id)
      }
    }
  }

  return {
    studioIds: [...new Set(studioIds)],
    projectIds: [...new Set(projectIds)],
  }
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Map each unnamed speaker to its own audio file id.
 *
 * Riverside gives an uploaded recording one diarized track per voice, named
 * exactly as the transcript labels them ("speaker-0", "Speaker 2"). That means
 * an anonymous speaker can be listened to in isolation, which is the only
 * practical way to say who they are. Prefer compressed_audio — it's a fraction
 * of the size of raw and fine for identifying a voice.
 */
function speakerMediaFor(rec: RiversideRecording, labels: string[]): Record<string, string> {
  const wanted = new Set(labels.map(l => l.toLowerCase().trim()))
  const media: Record<string, string> = {}

  for (const track of rec.tracks ?? []) {
    const name = track.track_name?.trim()
    if (!name || !wanted.has(name.toLowerCase())) continue

    const file =
      track.files?.find(f => f.type === "compressed_audio") ??
      track.files?.find(f => f.type === "raw_audio") ??
      track.files?.find(f => f.type === "audioEnhanced")
    if (!file) continue

    // download_url is ".../download/file/<id>"; keep the id, not the URL, so a
    // rotated host or query string doesn't invalidate stored rows.
    const id = file.download_url.split("/").pop()?.split("?")[0]
    if (id) media[name] = id
  }

  return media
}

function inferSource(rec: RiversideRecording): string {
  const context = `${rec.project_name ?? ""} ${rec.studio_name ?? ""} ${rec.name}`
  if (/more\s*or\s*less/i.test(context)) return "more-or-less"
  if (/partner\s*(meeting|mtg)/i.test(context)) return "partner-meeting"
  return "internal"
}

export type SyncResult = {
  checked: number
  autoConfirmed: number
  queued: number
  /** Already imported on an earlier run. */
  skipped: number
  /** Left for the next run because this one hit its cap. */
  deferred: number
  notReady: number
  errors: string[]
  /** Set when the shared key stopped working — this must not fail quietly. */
  authFailed?: boolean
  /** Nothing picked in the settings, so nothing was pulled. */
  noProjectsSelected?: boolean
}

/**
 * Pull new Riverside recordings into the transcript library.
 *
 * Attribution stays conservative on purpose. A recording is only extracted
 * without review when every speaker in it is a name we've already decided
 * about. Anything new, and anything that looks like a partner but isn't
 * certain, waits in the review queue — the two-Sams problem is real and a
 * wrong mapping puts someone else's words in a partner's library.
 */
export async function syncRiverside(opts: {
  /** How far back to look. Defaults to 30 days. */
  sinceDays?: number
  /** Cap per run so one backfill can't burn the shared rate limit budget. */
  limit?: number
} = {}): Promise<SyncResult> {
  const result: SyncResult = {
    checked: 0, autoConfirmed: 0, queued: 0, skipped: 0, deferred: 0, notReady: 0, errors: [],
  }

  const sinceDays = opts.sinceDays ?? 30
  const limit = opts.limit ?? 20
  const startDate = new Date(Date.now() - sinceDays * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const recordings: RiversideRecording[] = []
  try {
    const selected = await getSelectedProjects()

    // Only what was explicitly picked. Defaulting to the whole workspace would
    // hoover up every other production in the account, so an empty selection
    // means "nothing" rather than "everything".
    if (selected.length === 0) {
      return { ...result, noProjectsSelected: true }
    }

    const { studioIds, projectIds } = await expandSelection(selected)

    for (const projectId of projectIds) {
      recordings.push(...(await listRecordings({ projectId, startDate })))
    }
    for (const studioId of studioIds) {
      recordings.push(...(await listRecordings({ studioId, startDate })))
    }
  } catch (err) {
    if (err instanceof RiversideAuthError) {
      return { ...result, authFailed: true, errors: [err.message] }
    }
    return { ...result, errors: [err instanceof Error ? err.message : String(err)] }
  }

  // A studio scope and a project scope under it can both return the same row.
  const unique = [...new Map(recordings.map(r => [r.recording_id, r])).values()]
  result.checked = unique.length

  const existing = await prisma.transcript.findMany({
    where: { riversideId: { in: unique.map(r => r.recording_id) } },
    select: { riversideId: true },
  })
  const seen = new Set(existing.map(e => e.riversideId))

  let processed = 0

  for (const rec of unique) {
    if (seen.has(rec.recording_id)) { result.skipped++; continue }
    if (rec.status !== "ready" || rec.transcription?.status !== "done") {
      // Still uploading or transcribing — a later run will pick it up.
      result.notReady++
      continue
    }
    if (processed >= limit) { result.deferred++; continue }

    try {
      processed++
      const rawText = await downloadTranscript(rec.recording_id)
      if (!rawText.trim()) {
        result.errors.push(`${rec.name}: transcript came back empty`)
        continue
      }

      const detected = await detectSpeakers(rawText)
      const labels = detected.speakers.map(s => s.label)

      const row = await prisma.transcript.create({
        data: {
          title: rec.name,
          source: inferSource(rec),
          recordedAt: new Date(rec.created_date),
          participants: labels,
          rawText,
          status: "pending",
          riversideId: rec.recording_id,
          sourceProject: rec.project_name ?? rec.studio_name ?? null,
          speakerMedia: speakerMediaFor(rec, labels),
        },
      })

      // No speaker labels in the file at all. Nothing to attribute, and
      // guessing would be fiction — it sits in the queue so it's visible.
      if (detected.unlabeled) {
        result.queued++
        continue
      }

      const { speakerMap, unknown } = await resolveAliases(labels)

      // A name we haven't ruled on yet that *looks* like a partner is exactly
      // the case a human has to settle.
      const ambiguous = unknown.some(l => suggestPartner(l) !== null)

      if (unknown.length > 0 || ambiguous) {
        result.queued++
        continue
      }

      // Every speaker is a name we've decided about before — safe to extract.
      // (An empty map is a valid outcome: a guest-only recording has nothing
      // of ours in it, and confirming that keeps it out of the queue.)
      await confirmTranscript(row.id, speakerMap)
      result.autoConfirmed++
    } catch (err) {
      if (err instanceof RiversideAuthError) {
        return { ...result, authFailed: true, errors: [...result.errors, err.message] }
      }
      result.errors.push(
        `${rec.name}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  revalidatePath("/transcripts")
  return result
}
