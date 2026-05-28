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

function isReplyStyleCitation(content: string): boolean {
  const t = content.trim()
  // Too short to stand alone as a quote card
  if (t.length < 60) return true
  // References another Twitter user (reply to someone)
  if (/@[a-zA-Z0-9_]{1,15}/.test(t)) return true
  // Starts with reply-only openers that make no sense without the original tweet
  const replyOpeners = /^(exactly|this\.|yes\.|yep\.|💯|👆|👇|☝️|right\.|agreed\.|same\.|lol\.|ha\.|haha\.|wow\.|true\.|correct\.|indeed\.|totally\.|absolutely\.|fair\.)/i
  if (replyOpeners.test(t)) return true
  // Contains "this tweet", "that tweet", "the tweet"
  if (/\b(this|that|the) tweet\b/i.test(t)) return true
  return false
}

async function scoreTrend(trendEmbedding: number[]): Promise<{
  score: number
  partner: string
  citation: string
  sourceUrl: string
} | null> {
  const allContent = await prisma.partnerContent.findMany({
    select: { partner: true, content: true, sourceUrl: true, title: true, embedding: true, sourceType: true },
  })

  if (allContent.length === 0) return null

  // Step 1: Find the best-matching partner across all content types
  let bestScore = 0
  let bestPartner = ""

  for (const item of allContent) {
    if (!item.embedding || item.embedding.length === 0) continue
    const score = cosineSimilarity(trendEmbedding, item.embedding)
    if (score > bestScore) {
      bestScore = score
      bestPartner = item.partner
    }
  }

  if (bestScore <= 0.4 || !bestPartner) return null

  // Step 2: Find the best-matching TWEET from that partner for the citation.
  // Tweets are actual words the investor wrote — safe to quote verbatim.
  // Newsletter/blog content is full articles that would be out-of-context when sliced.
  let bestTweetScore = 0
  let bestTweetCitation = ""
  let bestTweetUrl = ""

  for (const item of allContent) {
    if (item.partner !== bestPartner) continue
    if (item.sourceType !== "tweet") continue
    if (!item.embedding || item.embedding.length === 0) continue
    const score = cosineSimilarity(trendEmbedding, item.embedding)
    if (score > bestTweetScore) {
      const citationText = item.content.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim()
      if (isReplyStyleCitation(citationText)) continue
      bestTweetScore = score
      bestTweetCitation = citationText
      bestTweetUrl = item.sourceUrl || ""
    }
  }

  // Step 3: Use tweet citation if found; fall back to best non-reply content from that partner
  if (bestTweetCitation) {
    return { score: bestScore, partner: bestPartner, citation: bestTweetCitation, sourceUrl: bestTweetUrl }
  }

  // Fallback: use the best-scoring non-tweet content from that partner (but skip quote card in this case)
  let fallbackCitation = ""
  let fallbackUrl = ""
  let fallbackContentScore = 0

  for (const item of allContent) {
    if (item.partner !== bestPartner) continue
    if (!item.embedding || item.embedding.length === 0) continue
    const score = cosineSimilarity(trendEmbedding, item.embedding)
    if (score > fallbackContentScore) {
      const lastSoftHyphen = item.content.lastIndexOf('\u00ad')
      const cleanedContent = lastSoftHyphen > 0 && lastSoftHyphen < item.content.length - 20
        ? item.content.slice(lastSoftHyphen + 1).trim()
        : item.content.trim()
      const citationText = cleanedContent.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 500)
      if (isReplyStyleCitation(citationText)) continue
      fallbackContentScore = score
      fallbackCitation = citationText
      fallbackUrl = item.sourceUrl || ""
    }
  }

  return { score: bestScore, partner: bestPartner, citation: fallbackCitation, sourceUrl: fallbackUrl }
}

// ─── Check for duplicate drafts ───────────────────────────────────────────────

async function buildDedupCache(): Promise<number[][]> {
  const recentSignals = await prisma.trendSignal.findMany({
    where: {
      status: "drafted",
      detectedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
    select: { headline: true, summary: true },
  })
  // Embed all historical signals in parallel (one batch, not per-article)
  return Promise.all(recentSignals.map(s => embed(`${s.headline} ${s.summary}`)))
}

function isDuplicate(trendEmbedding: number[], cachedEmbeddings: number[][]): boolean {
  for (const signalEmbedding of cachedEmbeddings) {
    if (cosineSimilarity(trendEmbedding, signalEmbedding) > 0.85) return true
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
    select: { id: true, title: true, partner: true, storageUrl: true, embedding: true, forcedNext: true },
  })

  // Tier 1: force-queued video — use it regardless of similarity
  const forced = videos.find(v => v.forcedNext)
  if (forced) {
    await prisma.videoLibrary.update({ where: { id: forced.id }, data: { forcedNext: false } })
    return { id: forced.id, title: forced.title, partner: forced.partner, storageUrl: forced.storageUrl }
  }

  // Get IDs of videos already used in approved/published drafts
  const usedDrafts = await prisma.postDraft.findMany({
    where: { status: { in: ["approved", "published"] }, videoId: { not: null } },
    select: { videoId: true },
  })
  const usedVideoIds = new Set(usedDrafts.map(d => d.videoId!))

  // Tier 2: unposted videos at lower threshold (0.4)
  let best: { id: string; title: string; partner: string; storageUrl: string; score: number } | null = null
  for (const video of videos) {
    if (!video.embedding || video.embedding.length === 0) continue
    if (usedVideoIds.has(video.id)) continue
    const sim = cosineSimilarity(trendEmbedding, video.embedding)
    if (sim > 0.4 && (!best || sim > best.score)) {
      best = { id: video.id, title: video.title, partner: video.partner, storageUrl: video.storageUrl, score: sim }
    }
  }
  if (best) return { id: best.id, title: best.title, partner: best.partner, storageUrl: best.storageUrl }

  // Tier 3: any video above 0.55 (original behavior)
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

  // Only send a quote card if the citation is tweet-length (actual direct quote, not an article excerpt)
  // Tweets are ≤280 chars; newsletter/blog fallback citations can be up to 500 chars and are out-of-context
  if (draft.partnerCitation && draft.partnerCitation.length >= 60 && draft.partnerCitation.length <= 280) {
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

  const [news, dedupCache] = await Promise.all([fetchTrendingNews(), buildDedupCache()])
  let skipped = 0

  // Score all articles, pick the single highest-scoring one per run
  let best: {
    article: typeof news[0]
    embedding: number[]
    match: { score: number; partner: string; citation: string; sourceUrl: string }
  } | null = null

  // Embed all articles in parallel, then score sequentially
  const articleEmbeddings = await Promise.all(
    news.map(a => embed(`${a.headline} ${a.summary}`))
  )

  for (let i = 0; i < news.length; i++) {
    const article = news[i]
    const trendEmbedding = articleEmbeddings[i]
    if (isDuplicate(trendEmbedding, dedupCache)) { skipped++; continue }
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

// ─── Generate video post draft ───────────────────────────────────────────────

async function generateVideoPostDraft(
  video: { title: string; transcript: string; topics: string[] },
  partner: string
): Promise<{ hook: string; body: string; citation: string }> {
  const partnerNames: Record<string, string> = {
    sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
  }
  const partnerHandles: Record<string, string> = {
    sam: "@lessin", will: "@wquist", yoni: "@yrechtman", megan: "@mmlightcap",
  }
  const name = partnerNames[partner] || partner
  const firstName = name.split(" ")[0]
  const handle = partnerHandles[partner] || ""

  const voiceSamples = await prisma.partnerContent.findMany({
    where: { partner, sourceType: "tweet" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { content: true },
  })
  const voiceExamples = voiceSamples.map((s, i) => `${i + 1}. "${s.content}"`).join("\n")

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
    messages: [{
      role: "user",
      content: `You are ghostwriting social posts for Slow Ventures to promote a video clip featuring ${name}.

The post's job is to tease a SPECIFIC insight or moment from the clip so followers click to watch. You must reference the actual content of the transcript — a real quote, a specific argument, a named company, a number, or a concrete moment. Do NOT write a generic description of what the video is "about."

Here are recent things ${firstName} has actually posted. Match this voice exactly — sentence structure, length, word choice:
${voiceExamples}
${feedbackSection}
VIDEO TITLE: "${video.title}"
TRANSCRIPT:
${video.transcript.slice(0, 3000)}

Write TWO versions — Twitter and LinkedIn — that tease the sharpest, most specific insight from this transcript.

TWITTER (under 220 characters, not counting the handle appended separately):
- Find the single most quotable, surprising, or counterintuitive line in the transcript and build the post around it
- Write it in ${firstName}'s voice as if they're pointing their audience to this moment
- Reference something specific — a named company, a claim, a number, a framing — not "we discussed X"
- No questions, no em dashes, no hashtags, no emojis, no corporate language
- Shorter is better

LINKEDIN (600-900 characters):
- Line 1: Sharp hook — the specific insight from the video that makes someone stop. Name the company/person/number.
- Lines 2-4: Expand the reasoning. Show why this specific point matters — the mechanism, the implication, the thing most people miss. Grounded in what was actually said in the transcript.
- Final line: Confident declarative. No questions.
- No em dashes, no hashtags, no bullet points

Return ONLY valid JSON:
{ "twitter": "...", "linkedin": "...", "citation": "exact quote or key line from transcript that the post is built around" }`,
    }],
  })

  const text = response.content[0]
  if (text.type !== "text") throw new Error("No text response")
  const raw = text.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(raw)
  const strip = (t: string) => t.replace(/—/g, "-").replace(/–/g, "-")

  return {
    hook: strip(`${parsed.twitter}\n\n${handle}`),
    body: strip(parsed.linkedin),
    citation: parsed.citation || video.title,
  }
}

// ─── Fetch trending tech tweets as topics ─────────────────────────────────────

async function fetchTrendingTechTweetsAsTopics(): Promise<{ headline: string; summary: string; url: string; source: string }[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) return []

  try {
    const query = encodeURIComponent(`(AI OR startup OR "venture capital" OR fintech OR SaaS OR "series A") min_faves:100 -is:retweet lang:en`)
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=public_metrics,text&expansions=author_id&user.fields=username`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      next: { revalidate: 0 },
    })
    const data = await res.json()

    if (!data.data || !Array.isArray(data.data)) return []

    const sorted = [...data.data].sort((a: { public_metrics: { like_count: number; retweet_count: number } }, b: { public_metrics: { like_count: number; retweet_count: number } }) =>
      (b.public_metrics.like_count + b.public_metrics.retweet_count) -
      (a.public_metrics.like_count + a.public_metrics.retweet_count)
    )

    return sorted.slice(0, 10).map((tweet: { id: string; text: string; author_id: string }) => {
      const username = data.includes?.users?.find((u: { id: string; username: string }) => u.id === tweet.author_id)?.username ?? "unknown"
      return {
        headline: tweet.text.slice(0, 100),
        summary: tweet.text,
        url: `https://twitter.com/${username}/status/${tweet.id}`,
        source: "X",
      }
    })
  } catch (e) {
    console.error("fetchTrendingTechTweetsAsTopics failed:", e)
    return []
  }
}

// ─── Generate video post draft with trend ────────────────────────────────────

async function generateVideoPostDraftWithTrend(
  video: { title: string; transcript: string; topics: string[] },
  partner: string,
  trend: { headline: string; summary: string }
): Promise<{ hook: string; body: string; citation: string }> {
  const partnerNames: Record<string, string> = {
    sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
  }
  const partnerHandles: Record<string, string> = {
    sam: "@lessin", will: "@wquist", yoni: "@yrechtman", megan: "@mmlightcap",
  }
  const name = partnerNames[partner] || partner
  const handle = partnerHandles[partner] || ""

  const voiceSamples = await prisma.partnerContent.findMany({
    where: { partner, sourceType: "tweet" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { content: true },
  })
  const voiceExamples = voiceSamples.map((s, i) => `${i + 1}. "${s.content}"`).join("\n")

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
    messages: [{
      role: "user",
      content: `You are creating social posts for ${name} at Slow Ventures that connect a specific video insight to what's trending right now on X.

TRENDING MOMENT:
"${trend.headline}"
${trend.summary}

VIDEO: "${video.title}"
TRANSCRIPT:
${video.transcript.slice(0, 3000)}

VOICE SAMPLES (match this exactly):
${voiceExamples}
${feedbackSection}
Your job: find the sharpest, most specific insight from the transcript that directly relates to the trending moment. Build both posts around that specific connection.

X POST (under 220 characters, not counting handle appended separately):
- Name the specific trend or company from the trending moment
- Connect it to a specific insight from the transcript — a quote, a number, a named company, a concrete claim
- Declarative and confident. No questions, no em dashes, no hashtags, no emojis
- Write something that makes someone want to share it in a VC group chat

LINKEDIN POST (600-900 characters):
- Line 1: One sharp hook connecting the trending moment to the video insight. Name the specific company/trend/number.
- Lines 2-4: Show the mechanism — why does this specific insight matter in light of the trend? What does it reveal that most people miss?
- Final line: Confident declarative. No questions.
- No em dashes, no hashtags, no bullet points

Return ONLY valid JSON:
{ "twitter": "...", "linkedin": "...", "citation": "exact quote or key line from transcript the posts are built around" }`,
    }],
  })

  const text = response.content[0]
  if (text.type !== "text") throw new Error("No text response")
  const raw = text.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(raw)
  const strip = (t: string) => t.replace(/—/g, "-").replace(/–/g, "-")

  return {
    hook: strip(`${parsed.twitter}\n\n${handle}`),
    body: strip(parsed.linkedin),
    citation: parsed.citation || video.title,
  }
}

// ─── Generate video drafts from trends ───────────────────────────────────────

export async function generateVideoDraftsFromTrends(): Promise<{
  generated: number
  drafts: { title: string; partner: string; trend: string }[]
  message?: string
}> {
  // 1. Fetch trending topics from both news and X
  const [newsTopics, tweetTopics] = await Promise.all([
    fetchTrendingNews().catch(() => [] as { headline: string; summary: string; url: string; source: string }[]),
    fetchTrendingTechTweetsAsTopics(),
  ])

  // X topics first, then news; deduplicate by headline
  const combined = [...tweetTopics, ...newsTopics]
  const seenHeadlines = new Set<string>()
  const topics = combined.filter(t => {
    const key = t.headline.slice(0, 60).toLowerCase()
    if (seenHeadlines.has(key)) return false
    seenHeadlines.add(key)
    return true
  })

  // 2. Get all videos with transcript + embedding
  const allVideos = await prisma.videoLibrary.findMany({
    select: { id: true, partner: true, title: true, topics: true, transcript: true, embedding: true, storageUrl: true },
  })

  // 3. Get recently used video IDs (3-month cooldown)
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)

  const recentVideoDrafts = await prisma.postDraft.findMany({
    where: {
      source: "video",
      createdAt: { gte: threeMonthsAgo },
      videoId: { not: null },
    },
    select: { videoId: true },
  })
  const recentVideoIds = new Set(recentVideoDrafts.map(d => d.videoId!))

  // 4. Filter to available videos
  const availableVideos = allVideos.filter(v =>
    v.transcript &&
    v.embedding &&
    v.embedding.length > 0 &&
    !recentVideoIds.has(v.id)
  )

  if (availableVideos.length === 0) {
    return { generated: 0, drafts: [], message: "No available videos — all have been used in the last 3 months or lack transcripts" }
  }

  // 5. Embed up to 30 topics in parallel
  const topicsToEmbed = topics.slice(0, 30)
  const topicEmbeddings = await Promise.all(topicsToEmbed.map(t => embed(`${t.headline} ${t.summary}`)))

  // 6. Score all (topic, video) pairs, collect those above threshold
  type Pair = { topicIdx: number; videoIdx: number; score: number }
  const pairs: Pair[] = []

  for (let ti = 0; ti < topicsToEmbed.length; ti++) {
    for (let vi = 0; vi < availableVideos.length; vi++) {
      const score = cosineSimilarity(topicEmbeddings[ti], availableVideos[vi].embedding!)
      if (score > 0.25) pairs.push({ topicIdx: ti, videoIdx: vi, score })
    }
  }

  // 7. Sort by score descending, pick top 5 with unique videos
  pairs.sort((a, b) => b.score - a.score)
  const usedVideoIndices = new Set<number>()
  const topPairs: Pair[] = []
  for (const pair of pairs) {
    if (usedVideoIndices.has(pair.videoIdx)) continue
    usedVideoIndices.add(pair.videoIdx)
    topPairs.push(pair)
    if (topPairs.length >= 5) break
  }

  if (topPairs.length === 0) {
    return { generated: 0, drafts: [], message: "No strong matches found between trending topics and your video library" }
  }

  // 8. Generate drafts for each match
  const results: { title: string; partner: string; trend: string }[] = []

  for (const pair of topPairs) {
    const video = availableVideos[pair.videoIdx]
    const trend = topicsToEmbed[pair.topicIdx]
    const partner = video.partner

    const { hook, body, citation } = await generateVideoPostDraftWithTrend(
      { title: video.title, transcript: video.transcript!, topics: video.topics },
      partner,
      trend
    )

    await prisma.postDraft.create({
      data: {
        partner,
        partnerCitation: citation,
        hook,
        body,
        platform: "both",
        videoId: video.id,
        status: "pending",
        source: "video",
        partnerSourceUrl: trend.headline,
      },
    })

    results.push({ title: video.title, partner, trend: trend.headline })
  }

  return { generated: results.length, drafts: results }
}
