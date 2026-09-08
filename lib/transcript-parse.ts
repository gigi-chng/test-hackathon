// Pure transcript parsing. Lives outside the "use server" action files because
// every export from those has to be an async server action, and these are
// ordinary synchronous helpers shared by the paste flow and the Riverside sync.

import type { Partner } from "@/lib/partners"

export type Segment = { speaker: string; text: string }

// Common exports we see: Riverside/Zoom "Name (00:00.000)", plain "Name:",
// and bracketed "[Name]". Timestamps are stripped either way.
//
// Riverside's API does NOT zero-pad — real output is "Yoni (0:3.504)" and
// "Josh Mohrer (26:29.744)", so minutes and seconds are both 1-2 digits, with
// an optional hour group for long recordings. Requiring \d{2} for seconds
// silently dropped every header in the first 10 seconds of a minute, and a
// dropped header gets appended as text to the previous speaker's segment —
// which puts one person's words in another's library.
const SPEAKER_PATTERNS: RegExp[] = [
  /^([A-Za-z][\w .'’\-()\/&+,]{0,48}?)\s*\((\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.:]\d{1,3})?)\)\s*$/,
  /^\[?([A-Za-z][\w .'’\-]{0,48}?)\]?\s*:\s*(.*)$/,
]

export function parseSegments(raw: string): Segment[] {
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

// Riverside labels some recordings "Speaker 1", "Speaker 2" instead of names —
// diarized but anonymous. These are positional, not identities: the Speaker 1
// of one recording is a different person from the Speaker 1 of the next. They
// must never be remembered as an alias, and must always go to review.
export function isGenericLabel(label: string): boolean {
  // Seen in real exports: "Speaker 1", "speaker-0", "speaker_2".
  return /^(speaker|guest|participant|host|track|unknown)[\s_-]*\d*$/i.test(label.trim())
}

// Suggest a partner for a speaker label, but never act on it unsupervised.
export function suggestPartner(speaker: string): Partner | null {
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

// Long monologues get split so one embedding doesn't have to represent an hour
// of talking. Split on segment boundaries, never mid-sentence.
export function chunk(texts: string[], target = 1800): string[] {
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
