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

  // Pull 5 recent tweets from this partner to use as voice examples
  const voiceSamples = await prisma.partnerContent.findMany({
    where: { partner, sourceType: "tweet" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { content: true },
  })

  const voiceExamples = voiceSamples.map((s, i) => `${i + 1}. "${s.content}"`).join("\n")

  // Pull recent feedback from past drafts
  const pastFeedback = await prisma.postDraft.findMany({
    where: { feedback: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { feedback: true },
  })

  const feedbackSection = pastFeedback.length > 0
    ? `\nPast feedback to incorporate:\n${pastFeedback.map((f, i) => `${i + 1}. ${f.feedback}`).join("\n")}\n`
    : ""

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `You are ghostwriting a tweet for Slow Ventures. It needs to sound exactly like ${partnerNames[partner]} wrote it — not a polished brand post, not a journalist summary. Their actual voice.

Here are recent things ${partnerNames[partner].split(" ")[0]} has actually posted. Study the sentence structure, word choice, length, and how they build an argument:

${voiceExamples}

---

${feedbackSection}Now they're reacting to this:
Trending: "${trend.headline}"
Context: "${trend.summary}"

Their relevant thinking on this:
"${citation}"
Source: ${sourceUrl}

Write a tweet that:
1. Sounds indistinguishable from the examples above — same rhythm, same directness, same level of detail
2. Takes a specific, non-obvious stance on why this moment matters
3. Ends with something that makes people want to reply or quote-tweet

Format:
1. HOOK: One sentence max. Sharp reframe, not a summary.
2. BODY: 2-3 sentences. Build the argument. Close with a provocation or open question.

Hard rules:
- Match ${partnerNames[partner].split(" ")[0]}'s natural sentence length and vocabulary from the examples
- No hashtags, no emojis
- No em dashes (—) anywhere in the post
- No "worth noting", "exciting", "important", "signals that"
- No corporate language, write like a person not a content team
- Do NOT include the partner handle, appended automatically
- Total under 240 characters

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
    body: `${parsed.body}\n\n${handle}`,
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
