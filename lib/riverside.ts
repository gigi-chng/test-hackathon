// Riverside Business API client.
//
// Two things shape this file:
//
// 1. The workspace has a single shared API key and someone else's integration
//    is already using it. Rate limits are per-workspace, so every request we
//    make is one they don't get. We stay under the documented 1 req/sec, back
//    off on 429 instead of hammering, and only ever issue GETs.
// 2. If they rotate the key, we get a 401 forever and a cron that fails
//    silently is worse than no cron. RiversideAuthError exists so the caller
//    can shout about it rather than log and move on.

const BASE = "https://platform.riverside.com/api/v3"

/** Key was rejected — almost always means it was regenerated on their side. */
export class RiversideAuthError extends Error {
  constructor(message = "Riverside rejected the API key (401)") {
    super(message)
    this.name = "RiversideAuthError"
  }
}

export class RiversideConfigError extends Error {
  constructor(message = "RIVERSIDE_API_KEY is not set") {
    super(message)
    this.name = "RiversideConfigError"
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Serialize every call through one gate. The docs say 1 req/sec on recordings
// and transcripts, so 1.2s of spacing leaves the other integration some room.
let chain: Promise<unknown> = Promise.resolve()
const MIN_GAP_MS = 1200
let lastCallAt = 0

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCallAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
    return fn()
  })
  // Keep the chain alive even if this call throws.
  chain = run.catch(() => {})
  return run
}

async function request(path: string, attempt = 0): Promise<Response> {
  const key = process.env.RIVERSIDE_API_KEY
  if (!key) throw new RiversideConfigError()

  const res = await throttled(() =>
    fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    })
  )

  if (res.status === 401 || res.status === 403) throw new RiversideAuthError()

  if (res.status === 429) {
    if (attempt >= 3) {
      throw new Error("Riverside rate limit — gave up after 3 retries")
    }
    // Their integration is probably mid-run. Wait longer each time.
    await sleep(3000 * 2 ** attempt)
    return request(path, attempt + 1)
  }

  if (!res.ok) {
    throw new Error(`Riverside API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  return res
}

// ─── Types (only the fields we actually use) ─────────────────────────────────

export type RiversideProject = { id: string; name: string; num_recordings: number }

export type RiversideStudio = {
  id: string
  name: string
  num_recordings: number
  projects?: RiversideProject[]
}

export type RiversideProduction = {
  id: string
  name: string
  num_recordings: number
  studios?: RiversideStudio[]
}

export type RiversideFile = { type: string; download_url: string }

export type RiversideTrack = {
  id: string
  type: string
  status: string
  /** Participant name for live recordings, "speaker-0"/"Speaker 2" for uploads. */
  track_name?: string | null
  files?: RiversideFile[]
}

export type RiversideRecording = {
  recording_id: string
  name: string
  tracks?: RiversideTrack[]
  project_id?: string
  project_name?: string
  studio_id?: string
  studio_name?: string
  status: "uploading" | "processing" | "ready" | "failed"
  created_date: string
  transcription?: {
    status: "transcribing" | "done"
    files?: { type: string; download_url: string }[]
  }
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/** The whole workspace tree: productions -> studios -> projects. */
export async function listProductions(): Promise<RiversideProduction[]> {
  const res = await request("/productions")
  const data = await res.json()
  return Array.isArray(data) ? data : (data?.data ?? [])
}

export async function listRecordings(opts: {
  projectId?: string
  studioId?: string
  startDate?: string // YYYY-MM-DD
  endDate?: string
  maxPages?: number
}): Promise<RiversideRecording[]> {
  const out: RiversideRecording[] = []
  const maxPages = opts.maxPages ?? 5

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ page: String(page) })
    if (opts.projectId) params.set("projectId", opts.projectId)
    if (opts.studioId) params.set("studioId", opts.studioId)
    if (opts.startDate) params.set("start_date", opts.startDate)
    if (opts.endDate) params.set("end_date", opts.endDate)

    const res = await request(`/recordings?${params}`)
    const body = await res.json()
    const rows: RiversideRecording[] = body?.data ?? []
    out.push(...rows)

    // Results come back newest-first and pages are 20 wide.
    if (!body?.next_page_url || rows.length === 0) break
    if (body.total_pages != null && page + 1 >= body.total_pages) break
  }

  return out
}

/**
 * The plain-text transcript for a recording. Transcription is per-recording,
 * not per-track, so whether we can attribute anything depends entirely on
 * whether Riverside writes speaker labels into this file.
 */
export async function downloadTranscript(recordingId: string): Promise<string> {
  const res = await request(`/download/transcription/${recordingId}?type=txt`)
  const body = await res.text()

  // Some download endpoints hand back a signed URL rather than the file.
  // Detect that instead of storing a JSON blob as if it were a transcript.
  const trimmed = body.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(body)
      const url = parsed?.url ?? parsed?.download_url ?? parsed?.signed_url
      if (typeof url === "string") {
        const file = await fetch(url, { cache: "no-store" })
        if (!file.ok) throw new Error(`Transcript download failed: ${file.status}`)
        return file.text()
      }
    } catch {
      // Not JSON after all — fall through and treat it as the transcript.
    }
  }

  return body
}

/**
 * Stream a stored file straight through. Returns the raw Response so a route
 * can pipe the body without buffering an hour of audio into memory. Riverside
 * download URLs need the workspace key, so they can never be linked directly
 * from an email — this is what the in-app player proxies.
 */
export async function fetchFile(fileId: string): Promise<Response> {
  return request(`/download/file/${fileId}`)
}

/** Cheap credential check for the settings UI. */
export async function checkRiversideAccess(): Promise<
  { ok: true; productions: number } | { ok: false; reason: string }
> {
  try {
    const productions = await listProductions()
    return { ok: true, productions: productions.length }
  } catch (err) {
    if (err instanceof RiversideConfigError) return { ok: false, reason: "NO_KEY" }
    if (err instanceof RiversideAuthError) return { ok: false, reason: "BAD_KEY" }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
