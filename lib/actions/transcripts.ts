"use server"

import OpenAI from "openai"
import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"
import { PARTNERS, type Partner } from "@/lib/partners"
import { generateTags } from "@/lib/ai/tags"
import {
  parseSegments,
  suggestPartner,
  chunk,
  isGenericLabel,
} from "@/lib/transcript-parse"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

// ─── Speaker parsing ─────────────────────────────────────────────────────────


export type DetectedSpeaker = {
  label: string
  lines: number
  words: number
  sample: string
  suggested: Partner | null
}

export async function detectSpeakers(raw: string): Promise<{
  speakers: DetectedSpeaker[]
  totalSegments: number
  unlabeled: boolean
}> {
  const segments = parseSegments(raw)

  // No speaker labels at all — a Whisper SRT, for instance. Whisper does not
  // diarize, so there is nothing to attribute and guessing would be fiction.
  if (segments.length === 0) {
    return { speakers: [], totalSegments: 0, unlabeled: true }
  }

  const byLabel = new Map<string, { lines: number; words: number; sample: string }>()
  for (const s of segments) {
    const entry = byLabel.get(s.speaker) ?? { lines: 0, words: 0, sample: "" }
    entry.lines += 1
    entry.words += s.text.split(/\s+/).length
    if (entry.sample.length < 160) entry.sample = (entry.sample + " " + s.text).trim().slice(0, 200)
    byLabel.set(s.speaker, entry)
  }

  const speakers = [...byLabel.entries()]
    .map(([label, v]) => ({ label, ...v, suggested: suggestPartner(label) }))
    .sort((a, b) => b.words - a.words)

  return { speakers, totalSegments: segments.length, unlabeled: false }
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

/**
 * Split a stored transcript into per-partner passages and write them to the
 * content library. Shared by the paste flow and the Riverside review queue so
 * both produce identical rows.
 */
async function extractPassages(record: {
  id: string
  title: string
  rawText: string
  recordedAt: Date | null
}, speakerMap: Record<string, string>) {
  const segments = parseSegments(record.rawText)
  const stored: Record<string, number> = {}
  const skipped: string[] = []

  for (const [partner, label] of Object.entries(speakerMap)) {
    if (!label || !(partner in PARTNERS)) continue

    const spoken = segments.filter(s => s.speaker === label).map(s => s.text)
    const chunks = chunk(spoken)
    if (chunks.length === 0) {
      skipped.push(`${partner}: nothing substantial attributed to "${label}"`)
      continue
    }

    let n = 0
    for (const [i, text] of chunks.entries()) {
      const sourceUrl = `transcript:${record.id}:${partner}:${i}`
      const [embedding, tags] = await Promise.all([embed(text), generateTags(text)])
      await prisma.partnerContent.create({
        data: {
          partner,
          // Own sourceType so spoken material stays separable from writing.
          sourceType: "transcript",
          sourceUrl,
          title: `${record.title} — ${PARTNERS[partner as Partner].displayName}`,
          content: text,
          embedding,
          tags,
          manual: true,
          publishedAt: record.recordedAt,
        },
      })
      n += 1
    }
    stored[partner] = n
  }

  await prisma.transcript.update({
    where: { id: record.id },
    data: {
      speakerMap,
      status: "confirmed",
      segmentCount: Object.values(stored).reduce((a, b) => a + b, 0),
    },
  })

  revalidatePath("/transcripts")
  revalidatePath("/content-library")
  return { stored, skipped }
}

export async function ingestTranscript(input: {
  title: string
  source: string
  recordedAt?: string
  rawText: string
  /** partner key -> speaker label, confirmed in the UI */
  speakerMap: Record<string, string>
}): Promise<{ transcriptId: string; stored: Record<string, number>; skipped: string[] }> {
  const segments = parseSegments(input.rawText)

  const record = await prisma.transcript.create({
    data: {
      title: input.title,
      source: input.source,
      recordedAt: input.recordedAt ? new Date(input.recordedAt) : null,
      participants: [...new Set(segments.map(s => s.speaker))],
      speakerMap: input.speakerMap,
      rawText: input.rawText,
      status: "confirmed",
    },
  })

  const result = await extractPassages(record, input.speakerMap)
  await rememberAliases(input.speakerMap, record.participants)

  return { transcriptId: record.id, ...result }
}

/**
 * Confirm a transcript the Riverside sync pulled in but couldn't map on its
 * own. Same extraction as the paste flow, plus the decisions get remembered so
 * the next episode with these names doesn't ask again.
 */
export async function confirmTranscript(
  id: string,
  speakerMap: Record<string, string>
): Promise<{ stored: Record<string, number>; skipped: string[] }> {
  const record = await prisma.transcript.findUnique({ where: { id } })
  if (!record) throw new Error("Transcript not found")
  if (record.status === "confirmed") {
    throw new Error("Already confirmed — delete it first to redo the mapping")
  }

  const result = await extractPassages(record, speakerMap)
  await rememberAliases(speakerMap, record.participants)
  return result
}

// ─── Remembered speaker labels ───────────────────────────────────────────────

/**
 * Record what a human decided about each label in this transcript: mapped
 * labels point at a partner, everything else present is a guest. Both are
 * worth keeping — "Marc Andreessen is not one of our partners" saves a
 * question next time too.
 */
async function rememberAliases(
  speakerMap: Record<string, string>,
  allLabels: string[]
) {
  const byLabel = new Map<string, string | null>()
  for (const label of allLabels) byLabel.set(label, null)
  for (const [partner, label] of Object.entries(speakerMap)) {
    if (label && partner in PARTNERS) byLabel.set(label, partner)
  }

  for (const [display, partner] of byLabel) {
    const label = display.toLowerCase().trim()
    if (!label) continue
    // "Speaker 1" is a position in one recording, not a person. Remembering it
    // would attribute the next recording's Speaker 1 to whoever this one was.
    if (isGenericLabel(label)) continue
    await prisma.speakerAlias.upsert({
      where: { label },
      create: { label, display, partner },
      update: { partner, display },
    })
  }
}

/** Look up remembered decisions for a set of labels. */
export async function resolveAliases(labels: string[]): Promise<{
  /** partner key -> label, for labels we've seen mapped before */
  speakerMap: Record<string, string>
  /** labels we have no decision for */
  unknown: string[]
}> {
  const normalized = labels.map(l => l.toLowerCase().trim()).filter(Boolean)
  const known = await prisma.speakerAlias.findMany({
    where: { label: { in: normalized } },
  })
  const byLabel = new Map(known.map(a => [a.label, a.partner]))

  const speakerMap: Record<string, string> = {}
  const unknown: string[] = []

  for (const label of labels) {
    const key = label.toLowerCase().trim()
    // Positional labels are never auto-resolved, however often they appear.
    if (isGenericLabel(key) || !byLabel.has(key)) {
      unknown.push(label)
      continue
    }
    const partner = byLabel.get(key)
    if (partner) speakerMap[partner] = label
  }

  return { speakerMap, unknown }
}

export async function listTranscripts() {
  return prisma.transcript.findMany({
    where: { status: "confirmed" },
    orderBy: [{ recordedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      source: true,
      recordedAt: true,
      participants: true,
      speakerMap: true,
      segmentCount: true,
      createdAt: true,
      sourceProject: true,
      riversideId: true,
    },
  })
}

export type PendingTranscript = {
  id: string
  title: string
  source: string
  recordedAt: Date | null
  sourceProject: string | null
  words: number
  speakers: DetectedSpeaker[]
  /** partner -> label, pre-filled from remembered aliases and name suggestions */
  seeded: Record<string, string>
  unlabeled: boolean
  /** Labels are positional ("Speaker 1"), so the reviewer has to listen. */
  anonymous: boolean
  /** Speaker labels with an isolated audio track available to play. */
  audioLabels: string[]
}

/**
 * Recordings the sync pulled in but wouldn't attribute on its own. Each one
 * arrives with the mapping pre-filled as far as it can be trusted; the human
 * step is confirming it, not typing it.
 */
export async function listPendingTranscripts(): Promise<PendingTranscript[]> {
  const rows = await prisma.transcript.findMany({
    where: { status: "pending" },
    orderBy: [{ recordedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  })

  const out: PendingTranscript[] = []

  for (const row of rows) {
    const detected = await detectSpeakers(row.rawText)
    const { speakerMap: remembered } = await resolveAliases(
      detected.speakers.map(s => s.label)
    )

    // Answers already tapped in the "who is this?" email outrank everything —
    // otherwise the dropdowns would look empty after answering by email.
    const tapped: Record<string, string> = {}
    for (const [label, partner] of Object.entries(
      (row.identifyChoices ?? {}) as Record<string, string>
    )) {
      if (partner && partner !== "none") tapped[partner] = label
    }

    // Remembered decisions next; first-name suggestions only fill the gaps.
    const seeded: Record<string, string> = { ...remembered, ...tapped }
    for (const s of detected.speakers) {
      if (!s.suggested) continue
      if (seeded[s.suggested]) continue
      if (Object.values(seeded).includes(s.label)) continue
      seeded[s.suggested] = s.label
    }

    out.push({
      id: row.id,
      title: row.title,
      source: row.source,
      recordedAt: row.recordedAt,
      sourceProject: row.sourceProject,
      words: row.rawText.split(/\s+/).filter(Boolean).length,
      speakers: detected.speakers,
      seeded,
      unlabeled: detected.unlabeled,
      anonymous: detected.speakers.some(s => isGenericLabel(s.label)),
      audioLabels: Object.keys((row.speakerMedia ?? {}) as Record<string, string>),
    })
  }

  return out
}

export async function deleteTranscript(id: string) {
  // Remove the partner content this transcript produced as well, otherwise a
  // bad speaker mapping stays baked into the voice profiles forever.
  await prisma.partnerContent.deleteMany({
    where: { sourceUrl: { startsWith: `transcript:${id}:` } },
  })
  await prisma.transcript.delete({ where: { id } })
  revalidatePath("/transcripts")
  revalidatePath("/content-library")
}
