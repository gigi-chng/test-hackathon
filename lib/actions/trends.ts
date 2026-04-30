"use server"

import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { prisma } from "@/lib/db/prisma"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return response.data[0].embedding
}

// ─── Fetch trending VC/tech news ──────────────────────────────────────────────

async function fetchTrendingNews(): Promise<{ headline: string; summary: string; url: string; source: string }[]> {
  const apiKey = process.env.NEWS_API_KEY
  if (!apiKey) throw new Error("NEWS_API_KEY not set")

  const queries = ["venture capital", "startup funding", "AI startup", "tech founder"]
  const allArticles: { headline: string; summary: string; url: string; source: string }[] = []

  for (const q of queries) {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=10&language=en&apiKey=${apiKey}`
    const res = await fetch(url, { next: { revalidate: 0 } })
    const data = await res.json()

    if (data.articles) {
      for (const a of data.articles) {
        if (!a.title || a.title === "[Removed]") continue
        allArticles.push({
          headline: a.title,
          summary: a.description || a.title,
          url: a.url,
          source: a.source?.name || "Unknown",
        })
      }
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>()
  return allArticles.filter(a => {
    if (seen.has(a.url)) return false
    seen.add(a.url)
    return true
  })
}

// ─── Score trend against partner knowledge base ───────────────────────────────

async function scoreTrend(trendEmbedding: number[]): Promise<{
  score: number
  partner: string
  citation: string
  sourceUrl: string
} | null> {
  const allContent = await prisma.partnerContent.findMany({
    select: { partner: true, content: true, sourceUrl: true, title: true, embedding: true },
  })

  if (allContent.length === 0) return null

  let best = { score: 0, partner: "", citation: "", sourceUrl: "" }

  for (const item of allContent) {
    if (!item.embedding || item.embedding.length === 0) continue
    const score = cosineSimilarity(trendEmbedding, item.embedding)
    if (score > best.score) {
      best = {
        score,
        partner: item.partner,
        citation: item.content.slice(0, 500),
        sourceUrl: item.sourceUrl || "",
      }
    }
  }

  return best.score > 0.4 ? best : null
}

// ─── Check for duplicate drafts ───────────────────────────────────────────────

async function isDuplicate(trendEmbedding: number[]): Promise<boolean> {
  const recentPosts = await prisma.postDraft.findMany({
    where: {
      status: { in: ["published", "pending"] },
      createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
    select: { hook: true, body: true },
  })

  for (const post of recentPosts) {
    const postText = `${post.hook} ${post.body}`
    const postEmbedding = await embed(postText)
    const sim = cosineSimilarity(trendEmbedding, postEmbedding)
    if (sim > 0.75) return true
  }
  return false
}

// ─── Check weekly draft cap ───────────────────────────────────────────────────

async function weeklyCapReached(): Promise<boolean> {
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - weekStart.getDay())
  weekStart.setHours(0, 0, 0, 0)

  const count = await prisma.postDraft.count({
    where: { createdAt: { gte: weekStart } },
  })
  return count >= 3
}

// ─── Generate post draft ──────────────────────────────────────────────────────

async function generateDraft(
  trend: { headline: string; summary: string },
  partner: string,
  citation: string,
  sourceUrl: string
): Promise<{ hook: string; body: string }> {
  const partnerNames: Record<string, string> = {
    sam: "Sam Lessin",
    will: "Will Quist",
    yoni: "Yoni Rechtman",
    megan: "Megan Lightcap",
  }

  const partnerHandles: Record<string, string> = {
    sam: "@lessin",
    will: "@wquist",
    yoni: "@yrechtman",
    megan: "@mmlightcap",
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `You are ghostwriting a tweet for Slow Ventures that will make people stop, think, and want to respond or repost.

Trending story: "${trend.headline}"
Summary: "${trend.summary}"

Here is how ${partnerNames[partner].split(" ")[0]} actually thinks about this space:
"${citation}"
Source: ${sourceUrl}

Your job: write a tweet that does three things at once:
1. Takes a clear, specific stance on why this moment matters — not obvious, not generic
2. Connects it to ${partnerNames[partner].split(" ")[0]}'s existing thinking in a way that feels earned, not name-droppy
3. Ends on something that makes people want to reply, quote-tweet, or share — a provocation, an open question, or a counterintuitive conclusion

Tone: think @paulg, @sama, @benedictevans, @pmarca at their best. Direct. Specific. Sounds like someone who already saw this coming. Not a brand. Not a journalist. A smart person with a real take.

Format: two parts
1. HOOK: One sentence. The sharpest possible entry point. Reframes the story, doesn't just repeat it.
2. BODY: 2-4 sentences. Explain why this actually matters, tie in ${partnerNames[partner].split(" ")[0]}'s POV naturally, and close with something that sparks a reaction — a bold claim, a tension, or an unresolved question.

Hard rules:
- No hashtags, no emojis
- No "worth noting", "exciting", "important", "as I've written"
- No reporter language ("signals", "marks a shift", "according to")
- The last sentence should make someone want to respond
- Sound like a person, not a content team
- Do NOT include the partner handle in your output — it will be appended automatically
- Total post under 240 characters (handle will be added at the end)

Return ONLY valid JSON:
{ "hook": "...", "body": "..." }`,
      },
    ],
  })

  const text = response.content[0]
  if (text.type !== "text") throw new Error("No text response")
  const raw = text.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(raw)

  // Append partner handle to body
  const handle = partnerHandles[partner]
  return {
    hook: parsed.hook,
    body: `${parsed.body}\n\n— ${handle}`,
  }
}

// ─── Find matching video ──────────────────────────────────────────────────────

async function findMatchingVideo(trendEmbedding: number[]): Promise<string | null> {
  const videos = await prisma.videoLibrary.findMany({
    select: { id: true, embedding: true },
  })

  for (const video of videos) {
    if (!video.embedding || video.embedding.length === 0) continue
    const sim = cosineSimilarity(trendEmbedding, video.embedding)
    if (sim > 0.75) return video.id
  }
  return null
}

// ─── Send Telegram approval message ──────────────────────────────────────────

async function sendTelegramApproval(draft: {
  hook: string
  body: string
  partner: string
  partnerCitation: string
  approvalToken: string
  videoId: string | null
  trend: { headline: string; source: string }
}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set")

  const partnerNames: Record<string, string> = {
    sam: "Sam Lessin",
    will: "Will Quist",
    yoni: "Yoni Rechtman",
    megan: "Megan Lightcap",
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const approveUrl = `${baseUrl}/api/agent/approve?token=${draft.approvalToken}&action=approve`
  const rejectUrl = `${baseUrl}/api/agent/approve?token=${draft.approvalToken}&action=reject`

  const fullText = [
    `📣 *Draft ready for approval*`,
    `_Responding to: ${draft.trend.headline} (${draft.trend.source})_`,
    ``,
    `─────────────────────`,
    `*WHAT WILL BE POSTED:*`,
    ``,
    `${draft.hook}`,
    ``,
    `${draft.body}`,
    `─────────────────────`,
    ``,
    `*Drawing on:* ${partnerNames[draft.partner]}`,
    `_"${draft.partnerCitation.slice(0, 150)}..."_`,
    draft.videoId ? `📎 Relevant video from library will be attached` : "",
    ``,
    `✅ Approve & post: ${approveUrl}`,
    `❌ Reject: ${rejectUrl}`,
  ].filter(line => line !== undefined && line !== null).join("\n")

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: fullText,
      parse_mode: "Markdown",
    }),
  })
}

// ─── Main: run the full agent pipeline ───────────────────────────────────────

export async function runAgentPipeline(): Promise<{ drafted: number; skipped: number; reason?: string }> {
  if (await weeklyCapReached()) {
    return { drafted: 0, skipped: 0, reason: "Weekly cap of 3 drafts reached" }
  }

  const news = await fetchTrendingNews()
  let skipped = 0

  // Score all articles, pick the single highest-scoring one per run
  let best: {
    article: typeof news[0]
    embedding: number[]
    match: { score: number; partner: string; citation: string; sourceUrl: string }
  } | null = null

  for (const article of news) {
    const trendEmbedding = await embed(`${article.headline} ${article.summary}`)
    if (await isDuplicate(trendEmbedding)) { skipped++; continue }
    const match = await scoreTrend(trendEmbedding)
    if (!match || match.score < 0.45) { skipped++; continue }
    if (!best || match.score > best.match.score) {
      best = { article, embedding: trendEmbedding, match }
    }
  }

  if (!best) return { drafted: 0, skipped }

  const { article, embedding: trendEmbedding, match } = best

  const videoId = await findMatchingVideo(trendEmbedding)

  const { hook, body } = await generateDraft(
    article,
    match.partner,
    match.citation,
    match.sourceUrl
  )

  const postDraft = await prisma.postDraft.create({
    data: {
      trendSignalId: null,
      partner: match.partner,
      partnerCitation: match.citation,
      hook,
      body,
      platform: "both",
      videoId,
      status: "pending",
    },
  })

  await prisma.trendSignal.create({
    data: {
      headline: article.headline,
      summary: article.summary,
      source: article.source,
      sourceUrl: article.url,
      relevanceScore: match.score,
      status: "drafted",
    },
  })

  await sendTelegramApproval({
    id: postDraft.id,
    hook,
    body,
    partner: match.partner,
    partnerCitation: match.citation,
    approvalToken: postDraft.approvalToken,
    videoId,
    trend: { headline: article.headline, source: article.source },
  })

  return { drafted: 1, skipped }
}
