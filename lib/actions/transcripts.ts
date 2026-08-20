"use server"

import OpenAI from "openai"
import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"
import { PARTNERS, type Partner } from "@/lib/partners"
import { generateTags } from "@/lib/ai/tags"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

// ─── Speaker parsing ─────────────────────────────────────────────────────────

export type Segment = { speaker: string; text: string }

// Common exports we see: Riverside/Zoom "Name (00:00.000)", plain "Name:",
// and bracketed "[Name]". Timestamps are stripped either way.
const SPEAKER_PATTERNS: RegExp[] = [
  /^([A-Za-z][\w .'’\-()]{0,48}?)\s*\((\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\)\s*$/,
  /^\[?([A-Za-z][\w .'’\-]{0,48}?)\]?\s*:\s*(.*)$/,
]

function parseSegments(raw: string): Segment[] {
  const lines = raw.split(/\r?\n/)
  const segments: Segment[] = []
  let current: Segment | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // "Name (00:00.000)" on its own line — speech follows on later lines
    const withTime = trimmed.match(SPEAKER_PATTERNS[0])
    if (withTime) {
      if (current?.text.trim()) segments.push(current)
      current = { speaker: withTime[1].trim(), text: "" }
      continue
    }

    // "Name: speech"
    const inline = trimmed.match(SPEAKER_PATTERNS[1])
    if (inline && inline[1].split(/\s+/).length <= 4 && inline[2] !== undefined) {
      if (current?.text.trim()) segments.push(current)
      current = { speaker: inline[1].trim(), text: inline[2].trim() }
      continue
    }

    if (current) current.text += (current.text ? " " : "") + trimmed
  }
  if (current?.text.trim()) segments.push(current)

  return segments.filter(s => s.text.trim().length > 0)
}

// Suggest a partner for a speaker label, but never act on it unsupervised.
function suggestPartner(speaker: string): Partner | null {
  const s = speaker.toLowerCase()
  if (/lessin/.test(s)) return "sam"
  if (/quist/.test(s)) return "will"
  if (/rechtman/.test(s)) return "yoni"
  if (/lightcap/.test(s)) return "megan"
  // Bare first names are deliberately weaker signals — an episode can have two
  // people sharing one, so these are suggestions a human still confirms.
  if (/^sam\b/.test(s)) return "sam"
  if (/^will\b/.test(s)) return "will"
  if (/^yoni\b/.test(s)) return "yoni"
  if (/^megan\b/.test(s)) return "megan"
  return null
}

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

// Long monologues get split so one embedding doesn't have to represent an hour
// of talking. Split on segment boundaries, never mid-sentence.
function chunk(texts: string[], target = 1800): string[] {
  const out: string[] = []
  let buf = ""
  for (const t of texts) {
    if (buf && buf.length + t.length > target) {
      out.push(buf)
      buf = t
    } else {
      buf = buf ? `${buf} ${t}` : t
    }
  }
  if (buf.trim()) out.push(buf)
  return out.filter(c => c.trim().length >= 200)
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
  const stored: Record<string, number> = {}
  const skipped: string[] = []

  const record = await prisma.transcript.create({
    data: {
      title: input.title,
      source: input.source,
      recordedAt: input.recordedAt ? new Date(input.recordedAt) : null,
      participants: [...new Set(segments.map(s => s.speaker))],
      speakerMap: input.speakerMap,
      rawText: input.rawText,
    },
  })

  for (const [partner, label] of Object.entries(input.speakerMap)) {
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
          title: `${input.title} — ${PARTNERS[partner as Partner].displayName}`,
          content: text,
          embedding,
          tags,
          manual: true,
          publishedAt: input.recordedAt ? new Date(input.recordedAt) : null,
        },
      })
      n += 1
    }
    stored[partner] = n
  }

  await prisma.transcript.update({
    where: { id: record.id },
    data: { segmentCount: Object.values(stored).reduce((a, b) => a + b, 0) },
  })

  revalidatePath("/transcripts")
  revalidatePath("/content-library")
  return { transcriptId: record.id, stored, skipped }
}

export async function listTranscripts() {
  return prisma.transcript.findMany({
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
    },
  })
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
