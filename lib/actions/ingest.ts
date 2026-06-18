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

// ─── Generic blog scraper ─────────────────────────────────────────────────────

async function scrapeBlogIndex(indexUrl: string): Promise<{ title: string; url: string }[]> {
  const res = await fetch(indexUrl, { next: { revalidate: 0 } })
  const html = await res.text()
  const $ = cheerio.load(html)

  const posts: { title: string; url: string }[] = []

  $("a").each((_, el) => {
    const href = $(el).attr("href") || ""
    const text = $(el).text().trim()
    if (!text || text.length < 10) return

    let url = href
    if (href.startsWith("/")) {
      const base = new URL(indexUrl)
      url = `${base.origin}${href}`
    } else if (!href.startsWith("http")) {
      return
    }

    if (
      url.includes("twitter.com") ||
      url.includes("linkedin.com") ||
      url.includes("mailto:") ||
      url === indexUrl
    ) return

    posts.push({ title: text, url })
  })

  const seen = new Set<string>()
  return posts.filter(p => {
    if (seen.has(p.url)) return false
    seen.add(p.url)
    return true
  })
}

async function scrapeArticleContent(url: string): Promise<string> {
  const res = await fetch(url, { next: { revalidate: 0 } })
  const html = await res.text()
  const $ = cheerio.load(html)

  $("nav, footer, script, style, header, aside, .sidebar, .navigation").remove()

  const selectors = ["article", "main", ".post-content", ".entry-content", ".content", "body"]
  for (const sel of selectors) {
    const text = $(sel).text().replace(/\s+/g, " ").trim()
    if (text.length > 200) return text
  }

  return $("body").text().replace(/\s+/g, " ").trim()
}

// ─── Substack scraper ─────────────────────────────────────────────────────────

async function scrapeSubstack(baseUrl: string): Promise<{ title: string; url: string; content: string }[]> {
  const feedUrl = `${baseUrl}/feed`
  const res = await fetch(feedUrl, { next: { revalidate: 0 } })
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })

  const posts: { title: string; url: string; content: string }[] = []

  $("item").each((_, el) => {
    const title = $(el).find("title").text().trim()
    const url = $(el).find("link").text().trim() || $(el).find("guid").text().trim()
    const content = $(el).find("content\\:encoded, description").first().text()
    const cleaned = cheerio.load(content).text().replace(/\s+/g, " ").trim()
    if (title && url && cleaned.length > 100) {
      posts.push({ title, url, content: cleaned })
    }
  })

  return posts
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

export async function ingestPartnerBlog(partner: Partner): Promise<{ ingested: number; skipped: number }> {
  const config = PARTNERS[partner]
  let ingested = 0
  let skipped = 0

  if (config.substackUrl) {
    const posts = await scrapeSubstack(config.substackUrl)
    for (const post of posts) {
      if (await alreadyIngested(post.url)) { skipped++; continue }
      const embedding = await embed(post.content)
      await prisma.partnerContent.create({
        data: {
          partner,
          sourceType: "newsletter",
          sourceUrl: post.url,
          title: post.title,
          content: post.content,
          embedding,
        },
      })
      ingested++
    }
  } else if (config.blogUrl) {
    const posts = await scrapeBlogIndex(config.blogUrl)
    for (const post of posts.slice(0, 30)) {
      if (await alreadyIngested(post.url)) { skipped++; continue }
      const content = await scrapeArticleContent(post.url)
      if (content.length < 100) { skipped++; continue }
      const embedding = await embed(content)
      await prisma.partnerContent.create({
        data: {
          partner,
          sourceType: "blog",
          sourceUrl: post.url,
          title: post.title,
          content,
          embedding,
        },
      })
      ingested++
    }
  }

  await prisma.partnerProfile.upsert({
    where: { partner },
    update: {},
    create: { partner },
  })

  return { ingested, skipped }
}

// ─── Ingest all partners ──────────────────────────────────────────────────────

export async function ingestAllPartners(): Promise<Record<Partner, { ingested: number; skipped: number }>> {
  const results = {} as Record<Partner, { ingested: number; skipped: number }>
  for (const partner of Object.keys(PARTNERS) as Partner[]) {
    const blog = await ingestPartnerBlog(partner)
    const twitter = await ingestPartnerTwitter(partner)
    const linkedin = await ingestPartnerLinkedIn(partner)
    results[partner] = {
      ingested: blog.ingested + twitter.ingested + linkedin.ingested,
      skipped: blog.skipped + twitter.skipped + linkedin.skipped,
    }
  }
  return results
}
