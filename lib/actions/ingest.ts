"use server"

import * as cheerio from "cheerio"
import OpenAI from "openai"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS, type Partner } from "@/lib/partners"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return response.data[0].embedding
}

// ─── Deduplication ────────────────────────────────────────────────────────────

async function alreadyIngested(sourceUrl: string): Promise<boolean> {
  const existing = await prisma.partnerContent.findFirst({
    where: { sourceUrl },
  })
  return !!existing
}

// ─── Blog fetching ────────────────────────────────────────────────────────────

// Squarespace/beehiiv reject requests that look like a bot, so send a real UA
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

type BlogPost = { title: string; url: string; publishedAt: Date | null }

async function fetchText(url: string, cookie?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    next: { revalidate: 0 },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  return res.text()
}

// Where each platform keeps the post body, most specific selector first
const ARTICLE_SELECTORS: Record<string, string[]> = {
  substack: [".available-content", ".body.markup", "article"],
  beehiiv: ["#content-blocks", ".rendered-post", "article"],
  wlessin: ["article", "main", ".post-content", ".content", "body"],
  generic: ["article", "main", ".post-content", ".entry-content", ".content", "body"],
}

const SOURCE_TYPE: Record<string, string> = {
  substack: "newsletter",
  beehiiv: "newsletter",
  wlessin: "blog",
  generic: "blog",
}

function extractArticle(html: string, selectors: string[]): { title: string; content: string } {
  const $ = cheerio.load(html)
  const title = $("h1").first().text().trim().replace(/\s+/g, " ")

  $("nav, footer, script, style, header, aside, form, .sidebar, .navigation").remove()

  for (const sel of selectors) {
    const text = $(sel).text().replace(/\s+/g, " ").trim()
    if (text.length > 200) return { title, content: text }
  }

  return { title, content: "" }
}

// ─── Post listing, one per platform ───────────────────────────────────────────

// Substack's RSS feed truncates most posts, so use the archive API instead
async function listSubstackPosts(baseUrl: string, limit: number): Promise<BlogPost[]> {
  const posts: BlogPost[] = []
  const pageSize = 12

  for (let offset = 0; offset < limit; offset += pageSize) {
    const raw = await fetchText(`${baseUrl}/api/v1/archive?sort=new&limit=${pageSize}&offset=${offset}`)
    const batch = JSON.parse(raw) as { title?: string; canonical_url?: string; post_date?: string }[]
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const post of batch) {
      if (!post.canonical_url) continue
      posts.push({
        title: post.title ?? "",
        url: post.canonical_url,
        publishedAt: post.post_date ? new Date(post.post_date) : null,
      })
    }

    if (batch.length < pageSize) break
  }

  return posts.slice(0, limit)
}

// beehiiv sites (wquist.com, meganlightcap.com) list every post in sitemap.xml, newest first
async function listBeehiivPosts(baseUrl: string, limit: number): Promise<BlogPost[]> {
  const xml = await fetchText(`${new URL(baseUrl).origin}/sitemap.xml`)
  const $ = cheerio.load(xml, { xmlMode: true })

  const posts: BlogPost[] = []
  $("url").each((_, el) => {
    const url = $(el).find("loc").text().trim()
    if (!url.includes("/p/")) return
    const lastmod = $(el).find("lastmod").text().trim()
    posts.push({ title: "", url, publishedAt: lastmod ? new Date(lastmod) : null })
  })

  return posts.slice(0, limit)
}

// wlessin.com is members-only — logged out, every post link points at /login
async function listWlessinPosts(indexUrl: string, cookie: string, limit: number): Promise<BlogPost[]> {
  const html = await fetchText(indexUrl, cookie)
  const $ = cheerio.load(html)

  const posts: BlogPost[] = []
  const seen = new Set<string>()

  $("a").each((_, el) => {
    const href = $(el).attr("href") ?? ""
    if (!href.includes("/p/") || href.includes("/login")) return

    const url = new URL(href, indexUrl).toString()
    if (seen.has(url)) return
    seen.add(url)

    posts.push({ title: $(el).text().trim().replace(/\s+/g, " "), url, publishedAt: null })
  })

  return posts.slice(0, limit)
}

// Last resort for sites with no sitemap or feed: every link on the index page
async function listGenericPosts(indexUrl: string, limit: number): Promise<BlogPost[]> {
  const html = await fetchText(indexUrl)
  const $ = cheerio.load(html)
  const origin = new URL(indexUrl).origin

  const posts: BlogPost[] = []
  const seen = new Set<string>()

  $("a").each((_, el) => {
    const href = $(el).attr("href") ?? ""
    const text = $(el).text().trim().replace(/\s+/g, " ")
    if (!href || text.length < 10) return

    let url: string
    try {
      url = new URL(href, indexUrl).toString()
    } catch {
      return
    }

    // Stay on the partner's own site and skip the index itself
    if (!url.startsWith(origin) || url === indexUrl || seen.has(url)) return
    seen.add(url)

    posts.push({ title: text, url, publishedAt: null })
  })

  return posts.slice(0, limit)
}

// ─── Twitter scraper ──────────────────────────────────────────────────────────

async function scrapeTwitter(handle: string): Promise<{ url: string; content: string }[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) throw new Error("TWITTER_BEARER_TOKEN not set")

  // Look up user ID from handle
  const userRes = await fetch(
    `https://api.twitter.com/2/users/by/username/${handle}?user.fields=id`,
    { headers: { Authorization: `Bearer ${bearerToken}` } }
  )
  const userData = await userRes.json()
  const userId = userData?.data?.id
  if (!userId) throw new Error(`Could not find Twitter user: ${handle}`)

  // Fetch recent tweets (up to 100)
  const tweetsRes = await fetch(
    `https://api.twitter.com/2/users/${userId}/tweets?max_results=100&tweet.fields=created_at,text&exclude=retweets,replies`,
    { headers: { Authorization: `Bearer ${bearerToken}` } }
  )
  const tweetsData = await tweetsRes.json()
  const tweets = tweetsData?.data || []

  return tweets.map((t: { id: string; text: string }) => ({
    url: `https://twitter.com/${handle}/status/${t.id}`,
    content: t.text,
  }))
}

export async function ingestPartnerTwitter(partner: Partner): Promise<{ ingested: number; skipped: number }> {
  const config = PARTNERS[partner]
  let ingested = 0
  let skipped = 0

  const tweets = await scrapeTwitter(config.twitterHandle)

  for (const tweet of tweets) {
    if (await alreadyIngested(tweet.url)) { skipped++; continue }
    if (tweet.content.length < 20) { skipped++; continue }
    const embedding = await embed(tweet.content)
    await prisma.partnerContent.create({
      data: {
        partner,
        sourceType: "tweet",
        sourceUrl: tweet.url,
        content: tweet.content,
        embedding,
      },
    })
    ingested++
  }

  return { ingested, skipped }
}

// ─── LinkedIn scraper via Apify ───────────────────────────────────────────────

async function scrapeLinkedIn(profileUrl: string): Promise<{ url: string; content: string }[]> {
  const token = process.env.APIFY_API_TOKEN
  if (!token) throw new Error("APIFY_API_TOKEN not set")

  // Start the actor run
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/apify~linkedin-profile-scraper/runs?token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileUrls: [profileUrl],
        maxPostCount: 50,
      }),
    }
  )
  const runData = await runRes.json()
  const runId = runData?.data?.id
  if (!runId) throw new Error("Failed to start Apify LinkedIn scraper")

  // Poll until finished (max 2 minutes)
  let status = "RUNNING"
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
    )
    const statusData = await statusRes.json()
    status = statusData?.data?.status
    if (status === "SUCCEEDED" || status === "FAILED") break
  }

  if (status !== "SUCCEEDED") throw new Error(`Apify run ${status}`)

  // Fetch results
  const datasetRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}`
  )
  const items = await datasetRes.json()

  const posts: { url: string; content: string }[] = []
  for (const item of items) {
    const itemPosts = item.posts || item.activities || []
    for (const post of itemPosts) {
      const content = post.text || post.commentary || post.content || ""
      const postUrl = post.url || post.postUrl || profileUrl
      if (content.length > 20) {
        posts.push({ url: postUrl, content })
      }
    }
  }

  return posts
}

export async function ingestPartnerLinkedIn(partner: Partner): Promise<{ ingested: number; skipped: number }> {
  const config = PARTNERS[partner]
  if (!config.linkedinUrl) return { ingested: 0, skipped: 0 }

  let ingested = 0
  let skipped = 0

  const posts = await scrapeLinkedIn(config.linkedinUrl)

  for (const post of posts) {
    if (await alreadyIngested(post.url)) { skipped++; continue }
    const embedding = await embed(post.content)
    await prisma.partnerContent.create({
      data: {
        partner,
        sourceType: "linkedin",
        sourceUrl: post.url,
        content: post.content,
        embedding,
      },
    })
    ingested++
  }

  return { ingested, skipped }
}

// ─── Ingest a single partner's blog ──────────────────────────────────────────

export type BlogIngestResult = {
  ingested: number
  skipped: number
  errors: number
  message?: string
}

export async function ingestPartnerBlog(partner: Partner, limit = 40): Promise<BlogIngestResult> {
  const config = PARTNERS[partner]
  const blogType: string = config.blogType
  const cookie = blogType === "wlessin" ? process.env.WLESSIN_COOKIE : undefined

  let posts: BlogPost[] = []

  if (blogType === "substack" && config.substackUrl) {
    posts = await listSubstackPosts(config.substackUrl, limit)
  } else if (blogType === "beehiiv" && config.blogUrl) {
    posts = await listBeehiivPosts(config.blogUrl, limit)
  } else if (blogType === "wlessin" && config.blogUrl) {
    if (!cookie) {
      return {
        ingested: 0,
        skipped: 0,
        errors: 0,
        message: "Sam's posts are members-only — set WLESSIN_COOKIE to ingest them",
      }
    }
    posts = await listWlessinPosts(config.blogUrl, cookie, limit)
  } else if (config.blogUrl) {
    posts = await listGenericPosts(config.blogUrl, limit)
  }

  const selectors = ARTICLE_SELECTORS[blogType] ?? ARTICLE_SELECTORS.generic
  const sourceType = SOURCE_TYPE[blogType] ?? "blog"

  let ingested = 0
  let skipped = 0
  let errors = 0

  for (const post of posts) {
    try {
      if (await alreadyIngested(post.url)) { skipped++; continue }

      const html = await fetchText(post.url, cookie)
      const article = extractArticle(html, selectors)
      if (article.content.length < 200) { skipped++; continue }

      const embedding = await embed(article.content)
      await prisma.partnerContent.create({
        data: {
          partner,
          sourceType,
          sourceUrl: post.url,
          title: post.title || article.title || null,
          content: article.content,
          embedding,
          publishedAt: post.publishedAt,
        },
      })
      ingested++
    } catch (err) {
      console.error(`[ingestPartnerBlog] ${partner} ${post.url}:`, err)
      errors++
    }
  }

  await prisma.partnerProfile.upsert({
    where: { partner },
    update: {},
    create: { partner },
  })

  return { ingested, skipped, errors }
}

// ─── Ingest all partners ──────────────────────────────────────────────────────

export async function ingestAllPartners(): Promise<Record<Partner, { ingested: number; skipped: number; errors: number }>> {
  const results = {} as Record<Partner, { ingested: number; skipped: number; errors: number }>

  for (const partner of Object.keys(PARTNERS) as Partner[]) {
    const totals = { ingested: 0, skipped: 0, errors: 0 }

    // One source failing (an expired LinkedIn scraper token, say) must not
    // take down the rest of the sync
    const sources: (() => Promise<{ ingested: number; skipped: number; errors?: number }>)[] = [
      () => ingestPartnerBlog(partner),
      () => ingestPartnerTwitter(partner),
      () => ingestPartnerLinkedIn(partner),
    ]

    for (const run of sources) {
      try {
        const result = await run()
        totals.ingested += result.ingested
        totals.skipped += result.skipped
        totals.errors += result.errors ?? 0
      } catch (err) {
        console.error(`[ingestAllPartners] ${partner}:`, err)
        totals.errors++
      }
    }

    results[partner] = totals
  }

  return results
}
