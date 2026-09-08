"use server"

import OpenAI from "openai"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS, type Partner } from "@/lib/partners"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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
