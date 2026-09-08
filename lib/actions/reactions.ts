"use server"

import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS, type Partner } from "@/lib/partners"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

export type Match = {
  sourceType: string
  title: string | null
  sourceUrl: string | null
  publishedAt: Date | null
  excerpt: string
  score: number
}

export type PartnerReaction = {
  partner: Partner
  displayName: string
  /** Best single score, which is what "has form on this" really means. */
  topScore: number
  matches: Match[]
}

// Below this, matches are topical noise rather than a point of view. Surfaced
// as "nothing on topic" instead of being hidden, so a thin result is legible
// rather than looking like a bug.
const RELEVANT = 0.35

/**
 * Find what the team has already said about a piece of text.
 *
 * Retrieval only — every line returned is something a partner actually wrote
 * or said, with its source. Nothing is generated, so a weak match reads as a
 * weak match instead of a confident paraphrase of nothing.
 *
 * Spoken passages from Riverside count the same as writing here. They are
 * often the better answer: people say things in a podcast they would never
 * publish, and until now that material was only shaping the voice profiles.
 */
export async function findReactions(
  text: string,
  opts: { perPartner?: number; sourceTypes?: string[] } = {}
): Promise<{
  reactions: PartnerReaction[]
  searched: number
  /** How much of the library is spoken material, for context on the results. */
  transcriptShare: number
}> {
  const perPartner = opts.perPartner ?? 4
  const trimmed = text.trim()
  if (trimmed.length < 20) {
    return { reactions: [], searched: 0, transcriptShare: 0 }
  }

  const [queryEmbedding, rows] = await Promise.all([
    embed(trimmed),
    prisma.partnerContent.findMany({
      where: opts.sourceTypes?.length ? { sourceType: { in: opts.sourceTypes } } : undefined,
      select: {
        partner: true,
        sourceType: true,
        title: true,
        sourceUrl: true,
        publishedAt: true,
        content: true,
        embedding: true,
      },
    }),
  ])

  const byPartner = new Map<Partner, Match[]>()
  let transcripts = 0
  let searched = 0

  for (const row of rows) {
    if (!row.embedding?.length) continue
    if (!(row.partner in PARTNERS)) continue
    searched += 1
    if (row.sourceType === "transcript") transcripts += 1

    const score = cosineSimilarity(queryEmbedding, row.embedding)

    // Strip URLs so a tweet's link doesn't eat the excerpt.
    const clean = row.content.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim()

    const list = byPartner.get(row.partner as Partner) ?? []
    list.push({
      sourceType: row.sourceType,
      title: row.title,
      sourceUrl: row.sourceUrl,
      publishedAt: row.publishedAt,
      excerpt: clean.slice(0, 420),
      score,
    })
    byPartner.set(row.partner as Partner, list)
  }

  const reactions: PartnerReaction[] = (Object.keys(PARTNERS) as Partner[])
    .map(partner => {
      const all = (byPartner.get(partner) ?? []).sort((a, b) => b.score - a.score)
      return {
        partner,
        displayName: PARTNERS[partner].displayName,
        topScore: all[0]?.score ?? 0,
        matches: all.filter(m => m.score >= RELEVANT).slice(0, perPartner),
      }
    })
    .sort((a, b) => b.topScore - a.topScore)

  return {
    reactions,
    searched,
    transcriptShare: searched > 0 ? transcripts / searched : 0,
  }
}

/** Source types present in the library, for the filter UI. */
export async function getSourceTypes(): Promise<{ sourceType: string; count: number }[]> {
  const groups = await prisma.partnerContent.groupBy({
    by: ["sourceType"],
    _count: { id: true },
  })
  return groups
    .map(g => ({ sourceType: g.sourceType, count: g._count.id }))
    .sort((a, b) => b.count - a.count)
}


// ─── Point of view ───────────────────────────────────────────────────────────

export type Pov = {
  partner: Partner
  displayName: string
  /** False when their past material doesn't support a distinctive position. */
  enoughBasis: boolean
  thesis: string
  argument: string
  contrarian: string
  /** The past pieces the argument was built from, numbered as the text cites them. */
  rootedIn: (Match & { n: number })[]
  note?: string
}

// A POV needs more than one loosely related hit to stand on. Below this we say
// so rather than dressing up thin evidence as conviction.
const POV_FLOOR = 0.42
const POV_MIN_MATCHES = 2

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Draft one partner's point of view on a piece of text.
 *
 * Two things keep this from being a generic take with a name attached. It only
 * argues from that partner's own past material, which is passed in numbered
 * and cited back so every claim is traceable to something they actually said.
 * And it refuses when the material doesn't support a distinctive position —
 * a confident paraphrase of nothing is worse than no answer, because it reads
 * exactly like a real position.
 *
 * Voice comes from the generated partner profile: tone, recurring themes, and
 * how they actually build an argument.
 */
export async function generatePov(text: string, partner: Partner): Promise<Pov> {
  const displayName = PARTNERS[partner].displayName
  const base: Pov = {
    partner, displayName, enoughBasis: false,
    thesis: "", argument: "", contrarian: "", rootedIn: [],
  }

  const [{ reactions }, profile] = await Promise.all([
    findReactions(text, { perPartner: 10 }),
    prisma.partnerProfile.findUnique({ where: { partner } }),
  ])

  const mine = reactions.find(r => r.partner === partner)
  const matches = (mine?.matches ?? []).filter(m => m.score >= POV_FLOOR)

  if (matches.length < POV_MIN_MATCHES) {
    return {
      ...base,
      note: `Only ${matches.length} piece${matches.length === 1 ? "" : "s"} of ${displayName}'s own material is close enough to this to argue from. Not enough to build a position they'd actually recognise.`,
    }
  }

  const excerpts = matches
    .map(
      (m, i) =>
        `[${i + 1}] ${m.sourceType}${m.title ? ` — ${m.title}` : ""}${
          m.publishedAt ? ` (${m.publishedAt.toISOString().slice(0, 10)})` : ""
        }\n${m.excerpt}`
    )
    .join("\n\n")

  const voice = profile
    ? `Tone: ${profile.toneOfVoice}\n\nWhat they believe: ${profile.pointOfView}\n\nHow they write: ${profile.styleNotes}\n\nRecurring themes: ${profile.themes.join(", ")}`
    : "No voice profile available — infer the voice from the excerpts alone."

  const response = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You work with ${displayName}, a partner at Slow Ventures. Someone has put a post in front of them and wants to know what ${displayName.split(" ")[0]} actually thinks about it — a real position, sharp enough to say publicly.

HOW THEY SOUND
${voice}

THINGS ${displayName.toUpperCase()} HAS ACTUALLY WRITTEN OR SAID
These are the only evidence you have about what they think. Numbered so you can cite them.

${excerpts}

---

THE POST THEY'RE REACTING TO
"""
${text.slice(0, 4000)}
"""

---

Work out the position that follows from what they have already said, and write it as them.

Rules that matter more than polish:

1. Argue only from the excerpts. If a claim isn't traceable to one of them, cut it. Never introduce a statistic, a company, a deal, or a prediction that isn't in the excerpts or in the post itself.
2. If the excerpts don't actually support a distinctive position on this topic — if they're merely topically adjacent — set enoughBasis to false and explain what's missing. Do not manufacture a take. A generic VC opinion with their name on it is the worst possible output.
3. Write in their register: how they'd say it to a smart friend in tech, not how it would appear in a memo. Match the sentence length and directness in the excerpts.
4. The thesis should be a claim someone could disagree with. "AI is changing things" is not a thesis. Their edge is usually a specific mechanism others are glossing over.
5. The contrarian field is what consensus this pushes against — the thing most people in the industry currently believe that this contradicts. If the position is actually consensus, say so plainly rather than pretending it's brave.

Reply with JSON only:

{
  "enoughBasis": true or false,
  "thesis": "1-2 sentences, first person, their voice, the position itself",
  "argument": "2-4 sentences of reasoning, drawing on the numbered excerpts",
  "contrarian": "1-2 sentences on what widely-held view this cuts against",
  "rootedIn": [numbers of the excerpts you actually used],
  "note": "only if enoughBasis is false: what's missing"
}`,
      },
    ],
  })

  const body = response.content.find(c => c.type === "text")
  const parsed = body && body.type === "text" ? extractJson(body.text) : null

  if (!parsed) {
    return { ...base, note: "Couldn't parse a position from the model response. Try again." }
  }

  // Cite back the real rows, so what's shown is verifiable rather than asserted.
  //
  // The prose cites excerpts inline as [2], [7], and the model doesn't always
  // repeat all of those in rootedIn — so take the union, and keep the original
  // numbering. Renumbering would leave a "[7]" in the text pointing at a
  // differently-numbered source, which is worse than no citation at all.
  const declared = Array.isArray(parsed.rootedIn)
    ? (parsed.rootedIn as unknown[]).map(Number).filter(n => Number.isFinite(n))
    : []

  const prose = [parsed.thesis, parsed.argument, parsed.contrarian]
    .filter(v => typeof v === "string")
    .join(" ")
  const inline = [...String(prose).matchAll(/\[(\d{1,2})\]/g)].map(m => Number(m[1]))

  const cited = [...new Set([...declared, ...inline])]
    .sort((a, b) => a - b)
    .map(n => {
      const match = matches[n - 1]
      return match ? { ...match, n } : null
    })
    .filter((m): m is Match & { n: number } => Boolean(m))

  const enoughBasis = parsed.enoughBasis === true && cited.length > 0

  return {
    partner,
    displayName,
    enoughBasis,
    thesis: String(parsed.thesis ?? ""),
    argument: String(parsed.argument ?? ""),
    contrarian: String(parsed.contrarian ?? ""),
    rootedIn: cited,
    note:
      parsed.enoughBasis === true && cited.length === 0
        ? "The draft didn't cite any of their own material, so it isn't grounded in anything they've said."
        : parsed.note
          ? String(parsed.note)
          : undefined,
  }
}
