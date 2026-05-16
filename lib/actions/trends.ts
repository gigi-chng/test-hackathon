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
      // Strip email template headers (navigation + soft-hyphen spacers) before slicing
      const lastSoftHyphen = item.content.lastIndexOf('\u00ad')
      const cleanedContent = lastSoftHyphen > 0 && lastSoftHyphen < item.content.length - 20
        ? item.content.slice(lastSoftHyphen + 1).trim()
        : item.content.trim()
      best = {
        score,
        partner: item.partner,
        citation: cleanedContent.slice(0, 500),
        sourceUrl: item.sourceUrl || "",
      }
    }
  }

  return best.score > 0.4 ? best : null
}

// ─── Check for duplicate drafts ───────────────────────────────────────────────

async function isDuplicate(trendEmbedding: number[]): Promise<boolean> {
  // Check against recently drafted trend signals (same article run through pipeline before)
  const recentSignals = await prisma.trendSignal.findMany({
    where: {
      status: "drafted",
      detectedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
    select: { headline: true, summary: true },
  })

  for (const signal of recentSignals) {
    const signalEmbedding = await embed(`${signal.headline} ${signal.summary}`)
    const sim = cosineSimilarity(trendEmbedding, signalEmbedding)
    if (sim > 0.85) return true
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

TWITTER (under 220 characters total, not counting the handle appended separately):
- Name the thing directly. Reference the specific news, company, or trend by name — don't be vague
- Lead with the sharpest possible take, not a warm-up sentence
- Surfaces an insight sophisticated investors have been saying privately but mainstream hasn't caught onto yet
- REPOST RULE: Write something someone wants to be the first to share in their VC/founder group chat — a claim that makes the sharer look smart or prescient. Must be specific, non-obvious, feels like insider access.
- REPLY RULE: State a strong opinion as fact — not hedged, not balanced. The best replies come from people who disagree. Lean into the controversial or counterintuitive angle. A contestable position beats a consensus take every time.
- BOOKMARK RULE: Include one thing that makes someone want to save it — a specific number, a counterintuitive framing, or a named company prediction they'll want to reference later.
- DWELL RULE: Write something that takes more than 2 seconds to process. A take with real density — a number, a named company, a mechanism — beats a one-liner platitude. Make them stop and think.
- PROFILE CLICK RULE: Write things that make people wonder "who is this." First-person stakes, contrarian claim, or identity hook. The reader should want to know more about the person behind the take.
- AVOID: generic phrasing that sounds like every other VC tweet. Avoid trigger words that land on mute lists. Avoid anything that could have been written by anyone. Topic consistency matters — stay in VC/tech/markets lane.
- Shorter is better. A punchy 140-character post outperforms a bloated 260-character one. Cut every word that doesn't add to the take.
- Declarative and confident — no questions, no hedging
- Hard rules: no em dashes, no hashtags, no emojis, no "worth noting/exciting/important/signals that", no corporate language

LINKEDIN (aim for 600-900 characters):
- ANCHOR RULE: Every LinkedIn post must be anchored to a SPECIFIC named company, named person, real data point, or dollar figure from the trend or the partner's citation. Never post a generic take without a real anchor. If the trend mentions a specific company — name it. If the citation has a dollar figure or stat — use it. This is the single most important rule.
- MATH RULE: When there are numbers in the trend (valuations, round sizes, percentages, multiples), do the actual arithmetic in the post. Show the calculation, not just the conclusion. "140x from seed gets you to $800B, which sounds incredible until you run the dilution" outperforms "the valuation is high." Readers share posts that do the math they didn't do themselves.
- Line 1: One sharp hook sentence — same energy as the Twitter post, makes someone stop scrolling. Name the specific company/person/number if possible.
- Lines 2-4: Expand the partner's actual thinking. Show the mechanism — why does this number or decision reveal something non-obvious? What does the math or the structure actually imply about strategy, incentives, or risk? The reader should feel like they're getting access to how a smart investor actually thinks through a deal or trend, not a summary of it.
- Final line: A confident declarative statement or sharp prediction. No questions.
- Write in the partner's voice with more room to breathe — LinkedIn readers expect more depth.
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

async function findMatchingVideo(trendEmbedding: number[]): Promise<{ id: string; title: string; partner: string; storageUrl: string } | null> {
  const videos = await prisma.videoLibrary.findMany({
    select: { id: true, title: true, partner: true, storageUrl: true, embedding: true },
  })

  let best: { id: string; title: string; partner: string; storageUrl: string; score: number } | null = null
  for (const video of videos) {
    if (!video.embedding || video.embedding.length === 0) continue
    const sim = cosineSimilarity(trendEmbedding, video.embedding)
    if (sim > 0.55 && (!best || sim > best.score)) {
      best = { id: video.id, title: video.title, partner: video.partner, storageUrl: video.storageUrl, score: sim }
    }
  }
  return best ? { id: best.id, title: best.title, partner: best.partner, storageUrl: best.storageUrl } : null
}

// ─── Send Telegram approval message ──────────────────────────────────────────

async function sendTelegramApproval(draft: {
  id: string
  hook: string
  body: string
  partner: string
  partnerCitation: string
  approvalToken: string
  video: { id: string; title: string; partner: string; storageUrl: string } | null
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
    draft.video
      ? draft.video.partner === "founder"
        ? `📎 Clip match (portfolio founder): "${draft.video.title}" — ${draft.video.storageUrl}`
        : `📎 Clip match: "${draft.video.title}" — ${draft.video.storageUrl}`
      : "",
    ``,
    `Reply *approve* (both), *approve twitter*, *approve linkedin*, *reject*, or *feedback: [note]*`,
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

  // Send quote card preview image (use ?id= so it pulls partnerCitation from DB)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://slow-hackathon-xi.vercel.app"
  const quoteCardUrl = `${appUrl}/api/quote-card?id=${draft.id}`
  const photoRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: quoteCardUrl,
      caption: "Quote card preview (attached to LinkedIn post)",
    }),
  })
  if (!photoRes.ok) {
    const err = await photoRes.text()
    console.error("Telegram sendPhoto failed:", err, "URL:", quoteCardUrl)
  }
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

  // Don't queue another draft if one is already waiting for approval
  const pendingCount = await prisma.postDraft.count({ where: { status: "pending" } })
  if (pendingCount >= 5) return { drafted: 0, skipped: 0, reason: "Draft queue full (5 pending)" }

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

  const [video, quoteTweet] = await Promise.all([
    findMatchingVideo(trendEmbedding),
    findTweetToQuote(article.headline, article.summary),
  ])

  const { hook: rawHook, body: rawBody } = await generateDraft(
    article,
    match.partner,
    match.citation,
    match.sourceUrl
  )

  // Strip em dashes regardless of what the model returns
  const stripEmDashes = (text: string) => text.replace(/—/g, "-").replace(/–/g, "-")
  const hook = stripEmDashes(rawHook)
  const body = stripEmDashes(rawBody)

  const postDraft = await prisma.postDraft.create({
    data: {
      trendSignalId: null,
      partner: match.partner,
      partnerCitation: match.citation,
      hook,
      body,
      platform: "both",
      videoId: video?.id ?? null,
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
    id: postDraft.id,
    hook,
    body,
    partner: match.partner,
    partnerCitation: match.citation,
    approvalToken: postDraft.approvalToken,
    video,
    quoteTweetUrl: quoteTweet?.url ?? null,
    trend: { headline: article.headline, source: article.source },
  })

  return { drafted: 1, skipped }
}
