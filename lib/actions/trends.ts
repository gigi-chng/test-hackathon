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
  const now = new Date()
  const day = now.getDay() // 0 = Sun, 1 = Mon ...
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((day + 6) % 7)) // roll back to Monday
  monday.setHours(0, 0, 0, 0)

  const count = await prisma.postDraft.count({
    where: {
      createdAt: { gte: monday },
      status: { in: ["pending", "published"] }, // don't count rejected drafts
    },
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

  const partnerLinkedIn: Record<string, string> = {
    sam: "linkedin.com/in/sam-lessin",
    will: "linkedin.com/in/will-quist-b4b4974",
    yoni: "linkedin.com/in/yrechtman",
    megan: "linkedin.com/in/megan-lightcap-513ab96b",
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
    max_tokens: 1800,
    messages: [
      {
        role: "user",
        content: `You are ghostwriting social posts for Slow Ventures. They need to sound exactly like ${partnerNames[partner]} wrote them — not a polished brand post, not a journalist summary. Their actual voice.

Here are recent things ${partnerNames[partner].split(" ")[0]} has actually posted. Study the sentence structure, word choice, length, and how they build an argument:

${voiceExamples}

---

${feedbackSection}They're reacting to this:
Trending: "${trend.headline}"
Context: "${trend.summary}"

Their relevant thinking on this:
"${citation}"
Source: ${sourceUrl}

Write TWO versions — one for Twitter, one for LinkedIn.

TWITTER (under 260 characters total including handle):
- Name the thing directly. Reference the specific news, company, or trend by name — don't be vague
- Lead with the sharpest possible take, not a warm-up sentence
- Surfaces an insight sophisticated investors have been saying privately but mainstream hasn't caught onto yet
- Declarative and confident — no questions, no hedging
- Hard rules: no em dashes, no hashtags, no emojis, no "worth noting/exciting/important/signals that", no corporate language

LINKEDIN (aim for 600-900 characters):
- Line 1: One sharp hook sentence — same energy as the Twitter post, makes someone stop scrolling
- Lines 2-4: Expand the partner's actual thinking. This is the educational part — explain the underlying thesis, what the partner has observed, why this trend matters from an investor/operator perspective. Reference the specific insight from their writing or tweets. Make the reader feel like they're getting access to how a smart investor actually thinks about this, not just a reaction.
- Final line: A confident declarative statement or sharp prediction — no questions
- Write in the partner's voice but with more room to breathe — LinkedIn readers expect more depth
- Hard rules: no em dashes, no hashtags, no questions at the end, no bullet points

Hard rules for BOTH:
- Match ${partnerNames[partner].split(" ")[0]}'s natural sentence length and vocabulary from the examples
- No em dashes (—) anywhere
- No "worth noting", "exciting", "important", "signals that"
- No corporate language, write like a person not a content team
- Do NOT end with a question
- Do NOT include any handle or profile link — attribution is appended automatically

Return ONLY valid JSON:
{ "twitter": "...", "linkedin": "..." }`,
      },
    ],
  })

  const text = response.content[0]
  if (text.type !== "text") throw new Error("No text response")
  const raw = text.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(raw)

  return {
    hook: `${parsed.twitter}\n\n${partnerHandles[partner]}`,
    body: parsed.linkedin,
  }
}

// ─── Find tweet to quote ─────────────────────────────────────────────────────

const TIER1_ACCOUNTS = [
  "techcrunch", "wsj", "bloomberg", "nytimes", "reuters",
  "ft", "theinformation", "wired", "verge", "forbes",
  "businessinsider", "axios", "theatlantic", "fastcompany",
]

async function findTweetToQuote(headline: string, keywords: string): Promise<{ id: string; url: string } | null> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) return null

  const encode = (s: string) => encodeURIComponent(s)

  // Build keyword query from headline (first 4 significant words)
  const keywordQuery = headline
    .split(" ")
    .filter(w => w.length > 3)
    .slice(0, 4)
    .join(" ")

  // Try tier 1 outlets first
  const tier1Query = `(${TIER1_ACCOUNTS.map(a => `from:${a}`).join(" OR ")}) (${keywordQuery}) -is:retweet lang:en`
  const tier1Url = `https://api.twitter.com/2/tweets/search/recent?query=${encode(tier1Query)}&max_results=10&tweet.fields=public_metrics,author_id&expansions=author_id&user.fields=username`

  try {
    const res = await fetch(tier1Url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    })
    const data = await res.json()
    if (data.data?.length > 0) {
      // Pick the tweet with most engagement
      const best = data.data.sort((a: { public_metrics: { retweet_count: number; like_count: number } }, b: { public_metrics: { retweet_count: number; like_count: number } }) =>
        (b.public_metrics.retweet_count + b.public_metrics.like_count) -
        (a.public_metrics.retweet_count + a.public_metrics.like_count)
      )[0]
      const username = data.includes?.users?.find((u: { id: string; username: string }) => u.id === best.author_id)?.username
      return { id: best.id, url: `https://twitter.com/${username}/status/${best.id}` }
    }
  } catch (e) {
    console.error("Tier 1 tweet search failed:", e)
  }

  // Fallback: any prominent tweet about the topic
  const fallbackQuery = `(${keywordQuery}) -is:retweet lang:en has:links`
  const fallbackUrl = `https://api.twitter.com/2/tweets/search/recent?query=${encode(fallbackQuery)}&max_results=10&tweet.fields=public_metrics,author_id&expansions=author_id&user.fields=username`

  try {
    const res = await fetch(fallbackUrl, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    })
    const data = await res.json()
    if (data.data?.length > 0) {
      const best = data.data.sort((a: { public_metrics: { retweet_count: number; like_count: number } }, b: { public_metrics: { retweet_count: number; like_count: number } }) =>
        (b.public_metrics.retweet_count + b.public_metrics.like_count) -
        (a.public_metrics.retweet_count + a.public_metrics.like_count)
      )[0]
      // Only use if it has meaningful engagement
      const engagement = best.public_metrics.retweet_count + best.public_metrics.like_count
      if (engagement < 10) return null
      const username = data.includes?.users?.find((u: { id: string; username: string }) => u.id === best.author_id)?.username
      return { id: best.id, url: `https://twitter.com/${username}/status/${best.id}` }
    }
  } catch (e) {
    console.error("Fallback tweet search failed:", e)
  }

  return null
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
  quoteTweetUrl: string | null
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

  const fullText = [
    `📣 *Draft ready for approval*`,
    `_Responding to: ${draft.trend.headline} (${draft.trend.source})_`,
    ``,
    `─────────────────────`,
    `*TWITTER:*`,
    ``,
    `${draft.hook}`,
    ``,
    `─────────────────────`,
    `*LINKEDIN:*`,
    ``,
    `${draft.body}`,
    `─────────────────────`,
    ``,
    `*Drawing on:* ${partnerNames[draft.partner]}`,
    `_"${draft.partnerCitation.slice(0, 150)}..."_`,
    draft.quoteTweetUrl ? `🔁 Will be posted as a quote-tweet: ${draft.quoteTweetUrl}` : `📝 No quote-tweet found — will post standalone`,
    draft.videoId ? `📎 Relevant video from library will be attached` : "",
    ``,
    `Reply *approve* to post both, *reject* to discard, or *feedback: [note]* to improve it.`,
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

  // Refresh knowledge base every Monday
  const today = new Date()
  if (today.getDay() === 1) {
    try {
      const { ingestAllPartners } = await import("@/lib/actions/ingest")
      await ingestAllPartners()
    } catch (e) {
      console.error("Ingestion failed (non-blocking):", e)
    }
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

  const [videoId, quoteTweet] = await Promise.all([
    findMatchingVideo(trendEmbedding),
    findTweetToQuote(article.headline, article.summary),
  ])

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
      quoteTweetId: quoteTweet?.id ?? null,
      quoteTweetUrl: quoteTweet?.url ?? null,
      partnerSourceUrl: match.sourceUrl ?? null,
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
    quoteTweetUrl: quoteTweet?.url ?? null,
    trend: { headline: article.headline, source: article.source },
  })

  return { drafted: 1, skipped }
}
