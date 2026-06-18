"use server"

import * as cheerio from "cheerio"
import OpenAI from "openai"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS } from "@/lib/partners"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const getResend = () => new Resend(process.env.RESEND_API_KEY)

// Credible outlets only
const CREDIBLE_DOMAINS = [
  "wsj.com", "nytimes.com", "ft.com", "bloomberg.com", "reuters.com",
  "techcrunch.com", "theverge.com", "wired.com", "fortune.com",
  "businessinsider.com", "arstechnica.com", "fastcompany.com",
  "technologyreview.com", "economist.com", "axios.com", "apnews.com",
  "forbes.com", "inc.com", "hbr.org", "theatlantic.com",
].join(",")

// Fallback themes if profiles haven't been generated yet
const FALLBACK_THEMES: Record<string, string[]> = {
  sam:   ["artificial intelligence", "venture capital", "creator economy", "technology policy", "future of work"],
  will:  ["product growth", "SMB", "consumer technology", "investing", "startups"],
  yoni:  ["creator economy", "media", "social platforms", "entrepreneurship", "venture capital"],
  megan: ["climate tech", "future of work", "diversity in tech", "venture capital", "technology"],
}

const PARTNER_COLORS: Record<string, string> = {
  sam: "#8b5cf6", will: "#0ea5e9", yoni: "#10b981", megan: "#f43f5e",
}

type Article = {
  title: string
  summary: string
  url: string
  source: string
  engagement?: string
}

// Simple English detection — filters out posts with predominantly non-Latin characters
function isEnglish(text: string): boolean {
  if (!text) return false
  const nonLatin = (text.match(/[^\u0000-\u024F\s]/g) ?? []).length
  return nonLatin / text.length < 0.2
}

// ─── Source fetchers ──────────────────────────────────────────────────────────

async function fetchHackerNews(themes: string[]): Promise<Article[]> {
  const articles: Article[] = []
  const seen = new Set<string>()

  for (const theme of themes.slice(0, 6)) {
    try {
      // Use search_by_date to get recent stories, sorted by recency + relevance
      const res = await fetch(
        `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(theme)}&hitsPerPage=8`,
        { signal: AbortSignal.timeout(8000) }
      )
      const data = await res.json()
      for (const hit of data.hits ?? []) {
        if (!hit.url || seen.has(hit.url)) continue
        if ((hit.points ?? 0) < 5) continue // skip very low quality
        if (!isEnglish(hit.title)) continue
        seen.add(hit.url)
        articles.push({
          title: hit.title,
          summary: hit.story_text?.replace(/<[^>]+>/g, "").slice(0, 200) ?? "",
          url: hit.url,
          source: "Hacker News",
          engagement: `${hit.points} pts · ${hit.num_comments} comments`,
        })
      }
    } catch {}
  }

  return articles
}

const REDDIT_SUBREDDITS = [
  "venturecapital", "startups", "MachineLearning", "artificial",
  "Entrepreneur", "technology", "media", "business",
]

async function fetchReddit(themes: string[]): Promise<Article[]> {
  const articles: Article[] = []
  const seen = new Set<string>()

  // Reddit JSON API requires OAuth — use public RSS feeds instead
  for (const subreddit of REDDIT_SUBREDDITS.slice(0, 5)) {
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${subreddit}/hot.rss?limit=10`,
        {
          headers: { "User-Agent": "SlowVenturesBot/1.0" },
          signal: AbortSignal.timeout(8000),
        }
      )
      if (!res.ok) continue
      const xml = await res.text()
      const $ = cheerio.load(xml, { xmlMode: true })

      $("entry, item").each((_, el) => {
        const title = $(el).find("title").first().text().trim()
        const link = $(el).find("link").attr("href") ?? $(el).find("link").text().trim()
        const summary = $(el).find("content, description").first().text().replace(/<[^>]+>/g, "").slice(0, 200).trim()
        if (!title || !link || seen.has(link)) return
        if (!isEnglish(title)) return
        seen.add(link)
        articles.push({
          title,
          summary,
          url: link,
          source: `Reddit r/${subreddit}`,
        })
      })
    } catch {}
  }

  return articles
}

// Shorten verbose profile themes to 1-2 word search terms NewsAPI can actually match
function simplifyThemes(themes: string[]): string[] {
  return themes
    .map(t => t.split(/\s+and\s+|\s+in\s+|\s+of\s+|\s+for\s+/i)[0].trim()) // take text before connectors
    .map(t => t.replace(/^the\s+/i, "").trim())                             // strip leading "the"
    .map(t => t.split(/\s+/).slice(0, 3).join(" "))                        // max 3 words
    .filter((t, i, arr) => t.length > 2 && arr.indexOf(t) === i)           // dedupe
}

async function fetchNewsAPI(themes: string[]): Promise<Article[]> {
  const apiKey = process.env.NEWS_API_KEY
  if (!apiKey) return []

  const articles: Article[] = []
  const seen = new Set<string>()
  const simplified = simplifyThemes(themes)
  const query = simplified.slice(0, 6).join(" OR ")

  try {
    const res = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&domains=${CREDIBLE_DOMAINS}&sortBy=publishedAt&pageSize=30&language=en`,
      {
        headers: { "X-Api-Key": apiKey },
        signal: AbortSignal.timeout(8000),
      }
    )
    const data = await res.json()
for (const a of data.articles ?? []) {
      if (!a.url || seen.has(a.url) || a.title === "[Removed]") continue
      seen.add(a.url)
      articles.push({
        title: a.title,
        summary: a.description ?? "",
        url: a.url,
        source: a.source?.name ?? "News",
      })
    }
  } catch {}

  return articles
}

async function fetchTwitter(themes: string[]): Promise<Article[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) return []

  const articles: Article[] = []
  const seen = new Set<string>()

  for (const theme of themes.slice(0, 4)) {
    try {
      const params = new URLSearchParams({
        query: `"${theme}" -is:retweet lang:en`,
        max_results: "10",
        "tweet.fields": "public_metrics,created_at",
        sort_order: "relevancy",
      })
      const res = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?${params}`,
        {
          headers: { Authorization: `Bearer ${bearerToken}` },
          signal: AbortSignal.timeout(8000),
        }
      )
      const data = await res.json()
      for (const tweet of data.data ?? []) {
        const url = `https://twitter.com/i/web/status/${tweet.id}`
        if (seen.has(url)) continue
        seen.add(url)
        const m = tweet.public_metrics
        articles.push({
          title: tweet.text.slice(0, 120) + (tweet.text.length > 120 ? "…" : ""),
          summary: tweet.text,
          url,
          source: "X (Twitter)",
          engagement: `${m.retweet_count} RTs · ${m.like_count} likes`,
        })
      }
    } catch {}
  }

  return articles
}

// ─── Sent URL tracking (dedup across days) ────────────────────────────────────

const SENT_URLS_KEY = "media_monitor_sent_urls"
const SENT_TTL_DAYS = 7

async function loadSentUrls(): Promise<Set<string>> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SENT_URLS_KEY } })
    if (!row) return new Set()
    const parsed: { url: string; sentAt: string }[] = JSON.parse(row.value)
    const cutoff = Date.now() - SENT_TTL_DAYS * 86400000
    return new Set(parsed.filter(r => new Date(r.sentAt).getTime() > cutoff).map(r => r.url))
  } catch {
    return new Set()
  }
}

async function saveSentUrls(newUrls: string[], existing: Set<string>) {
  try {
    const cutoff = Date.now() - SENT_TTL_DAYS * 86400000
    const now = new Date().toISOString()
    // Load current stored records (to preserve sentAt timestamps)
    const row = await prisma.appSetting.findUnique({ where: { key: SENT_URLS_KEY } })
    const stored: { url: string; sentAt: string }[] = row ? JSON.parse(row.value) : []
    // Keep recent existing + add new ones
    const kept = stored.filter(r => new Date(r.sentAt).getTime() > cutoff)
    const added = newUrls.filter(u => !existing.has(u)).map(u => ({ url: u, sentAt: now }))
    const merged = [...kept, ...added]
    await prisma.appSetting.upsert({
      where: { key: SENT_URLS_KEY },
      update: { value: JSON.stringify(merged) },
      create: { key: SENT_URLS_KEY, value: JSON.stringify(merged) },
    })
  } catch {}
}

// ─── GPT matching ─────────────────────────────────────────────────────────────

async function matchToPartners(
  articles: Article[],
  profiles: Record<string, { displayName: string; themes: string[] }>
): Promise<Record<string, Article[]>> {
  if (articles.length === 0) return {}

  const profileSummary = Object.entries(profiles)
    .map(([key, p]) => `${key} (${p.displayName}): ${p.themes.join(", ")}`)
    .join("\n")

  const articleList = articles
    .map((a, i) => `[${i}] ${a.title} — ${a.source}`)
    .join("\n")

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Match news articles to partners based on their interests. Apply these rules strictly:
1. Only include articles scoring 8+/10 relevance — be selective, not generous
2. Pick at most 3 articles per partner
3. Ensure the 3 articles cover DIFFERENT themes — no two articles on the same topic
4. Each article can match multiple partners if genuinely relevant to both

Return JSON: { "matches": { "sam": [0, 3], "will": [1], "yoni": [2, 4], "megan": [5] } }
Use the array index. Omit partners with no strong matches.`,
      },
      {
        role: "user",
        content: `Partner interests:\n${profileSummary}\n\nArticles:\n${articleList}`,
      },
    ],
  })

  const parsed = JSON.parse(res.choices[0].message.content ?? "{}")
  const result: Record<string, Article[]> = {}

  for (const [partner, indices] of Object.entries(parsed.matches ?? {})) {
    result[partner] = (indices as number[]).map(i => articles[i]).filter(Boolean)
  }

  return result
}

// ─── Email builder ────────────────────────────────────────────────────────────

function buildEmail(matches: Record<string, Article[]>): string {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  })

  const sourceIcon: Record<string, string> = {
    "Hacker News": "🟠",
    "X (Twitter)": "𝕏",
    "Reddit": "🤖",
    "News": "📰",
  }

  function icon(source: string) {
    for (const [k, v] of Object.entries(sourceIcon)) {
      if (source.startsWith(k)) return v
    }
    return "📄"
  }

  let sections = ""

  for (const [partnerKey, articles] of Object.entries(matches)) {
    if (!articles.length) continue
    const name = PARTNERS[partnerKey as keyof typeof PARTNERS]?.displayName ?? partnerKey
    const color = PARTNER_COLORS[partnerKey] ?? "#888"
    const top = articles.slice(0, 5)

    let cards = ""
    for (const a of top) {
      cards += `
      <div style="margin-bottom:10px;padding:12px 14px;background:#f8f8f8;border-radius:8px;border-left:3px solid ${color};">
        <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#111;">${a.title}</p>
        ${a.summary ? `<p style="margin:0 0 6px;font-size:12px;color:#666;line-height:1.5;">${a.summary.slice(0, 160)}${a.summary.length > 160 ? "…" : ""}</p>` : ""}
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <span style="font-size:11px;color:#999;">${icon(a.source)} ${a.source}</span>
          ${a.engagement ? `<span style="font-size:11px;color:#999;">${a.engagement}</span>` : ""}
          <a href="${a.url}" style="font-size:11px;color:${color};text-decoration:none;font-weight:500;">Read →</a>
        </div>
      </div>`
    }

    sections += `
    <div style="margin-bottom:28px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${color};">${name}</p>
      ${cards}
    </div>`
  }

  if (!sections) {
    sections = `<p style="color:#999;font-size:14px;">No strong matches found today. Try again tomorrow.</p>`
  }

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;color:#111;padding:24px 16px;">
  <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;">Media Monitor</h2>
  <p style="margin:0 0 28px;font-size:13px;color:#999;">${date} · Hacker News · Reddit · NewsAPI · X</p>
  ${sections}
  <p style="margin-top:32px;font-size:11px;color:#ccc;border-top:1px solid #eee;padding-top:16px;">
    Slow Ventures Content Intelligence · <a href="https://slow-hackathon.vercel.app/content-library" style="color:#ccc;">Content Library</a>
  </p>
</div>`
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function scanNews(): Promise<{ matched: number; sent: boolean; sources: Record<string, number> }> {
  // Load partner profiles (fall back to hardcoded themes if not generated yet)
  const profiles = await prisma.partnerProfile.findMany({
    select: { partner: true, themes: true },
  })

  const partnerThemes: Record<string, { displayName: string; themes: string[] }> = {}

  for (const [key, config] of Object.entries(PARTNERS)) {
    const profile = profiles.find(p => p.partner === key)
    partnerThemes[key] = {
      displayName: config.displayName,
      themes: profile?.themes?.length ? profile.themes : FALLBACK_THEMES[key] ?? [],
    }
  }

  // Collect all unique themes across partners for broad searching
  const allThemes = [...new Set(Object.values(partnerThemes).flatMap(p => p.themes))]

  // Fetch from all sources in parallel
  const [hnArticles, redditArticles, newsArticles, twitterArticles] = await Promise.all([
    fetchHackerNews(allThemes),
    fetchReddit(allThemes),
    fetchNewsAPI(allThemes),
    fetchTwitter(allThemes),
  ])

  // Load URLs already sent in the last 7 days
  const sentUrls = await loadSentUrls()

  // Deduplicate across sources and filter previously sent
  const seen = new Set<string>()
  const allArticles: Article[] = []
  for (const a of [...hnArticles, ...redditArticles, ...newsArticles, ...twitterArticles]) {
    if (!seen.has(a.url) && !sentUrls.has(a.url)) {
      seen.add(a.url)
      allArticles.push(a)
    }
  }

  const sources = {
    "Hacker News": hnArticles.length,
    "Reddit": redditArticles.length,
    "NewsAPI": newsArticles.length,
    "X": twitterArticles.length,
    "total": allArticles.length,
  }

  if (allArticles.length === 0) {
    return { matched: 0, sent: false, sources }
  }

  // Match to partners with GPT
  const matches = await matchToPartners(allArticles, partnerThemes)
  const totalMatched = Object.values(matches).reduce((sum, arr) => sum + arr.length, 0)

  // Send email
  const to = process.env.REPORT_EMAIL
  if (to && process.env.RESEND_API_KEY) {
    const html = buildEmail(matches)
    await getResend().emails.send({
      from: "Media Monitor <onboarding@resend.dev>",
      to,
      subject: `Media Monitor — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      html,
    }).catch(() => {})

    // Record sent URLs so they don't appear again for 7 days
    const sentArticleUrls = Object.values(matches).flat().map(a => a.url)
    await saveSentUrls(sentArticleUrls, sentUrls)
  }

  return { matched: totalMatched, sent: !!process.env.REPORT_EMAIL, sources }
}
