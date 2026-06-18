"use server"

import * as cheerio from "cheerio"
import OpenAI from "openai"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"
import { PARTNERS } from "@/lib/partners"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const getResend = () => new Resend(process.env.RESEND_API_KEY)

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

async function generateTags(text: string): Promise<string[]> {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract 3-6 concise topic tags from the content. Tags should be lowercase, 1-3 words, representing key themes (e.g. "venture capital", "creator economy", "SMB", "fundraising", "product growth"). Return JSON: { "tags": ["tag1", "tag2"] }`,
        },
        { role: "user", content: text.slice(0, 3000) },
      ],
    })
    const parsed = JSON.parse(res.choices[0].message.content ?? "{}")
    return Array.isArray(parsed.tags) ? parsed.tags.map((t: string) => t.toLowerCase().trim()) : []
  } catch {
    return []
  }
}

async function notifyZapier(item: {
  partner: string
  sourceType: string
  title?: string | null
  content: string
  tags: string[]
  sourceUrl?: string | null
  publishedAt?: Date | null
}) {
  const url = process.env.ZAPIER_WEBHOOK_URL
  if (!url) return
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partner: item.partner,
      type: item.sourceType,
      title: item.title ?? "",
      content: item.content.slice(0, 1000),
      tags: item.tags.join(", "),
      source_url: item.sourceUrl ?? "",
      published_date: item.publishedAt ? new Date(item.publishedAt).toISOString().split("T")[0] : "",
      added_date: new Date().toISOString().split("T")[0],
    }),
  }).catch(() => {})
}

async function sendEmailReport(subject: string, html: string) {
  const to = process.env.REPORT_EMAIL
  if (!to || !process.env.RESEND_API_KEY) return
  await getResend().emails.send({
    from: "Content Library <onboarding@resend.dev>",
    to,
    subject,
    html,
  }).catch(() => {})
}

async function alreadyIngested(sourceUrl: string): Promise<boolean> {
  const existing = await prisma.partnerContent.findFirst({ where: { sourceUrl } })
  return !!existing
}

// ─── URL Scraper ──────────────────────────────────────────────────────────────

export async function scrapeUrl(url: string): Promise<{ success: boolean; title?: string; text?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SlowBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` }

    const html = await res.text()
    const $ = cheerio.load(html)

    const title = $("title").first().text().trim() ||
      $("h1").first().text().trim() ||
      ""

    $("nav, footer, script, style, header, aside, .sidebar, .navigation, .comments").remove()

    const selectors = ["article", "main", ".post-content", ".entry-content", ".content", ".article-body", "body"]
    let text = ""
    for (const sel of selectors) {
      const t = $(sel).text().replace(/\s+/g, " ").trim()
      if (t.length > 200) { text = t; break }
    }

    if (!text) return { success: false, error: "Could not extract readable text from this URL" }

    return { success: true, title, text }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to fetch URL" }
  }
}

// ─── Speaker Detection ────────────────────────────────────────────────────────

export type SpeakerDetectionResult =
  | { status: "labeled"; extractedContent: string; speakerLabel: string }
  | { status: "unlabeled"; speakers: { id: string; samples: string[]; wordCount: number }[] }
  | { status: "single_speaker"; content: string }

export async function detectSpeakers(
  transcript: string,
  partnerName: string
): Promise<SpeakerDetectionResult> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are analyzing a podcast or interview transcript to identify speakers.

Your job:
1. Check if the transcript has speaker labels (e.g. "Sam:", "[Host]:", "SPEAKER_0:", "Interviewer:", names before colons, etc.)
2. If labeled:
   - Identify which label belongs to "${partnerName}" (may match by name, nickname, or role)
   - Extract ONLY that person's spoken lines (remove the label prefix itself)
   - Return their content as clean continuous text
3. If unlabeled:
   - Identify 2-4 distinct voices based on vocabulary, topics, sentence structure, and speaking patterns
   - Return 3 representative sample quotes per speaker (each 1-3 sentences, verbatim from the transcript)
   - Estimate word count per speaker
4. If there is clearly only one speaker throughout, say so

Return JSON in one of these shapes:
{ "status": "labeled", "speakerLabel": "Sam", "extractedContent": "full text of only Sam's lines..." }
{ "status": "unlabeled", "speakers": [{ "id": "Speaker A", "samples": ["quote1", "quote2", "quote3"], "wordCount": 1200 }, ...] }
{ "status": "single_speaker", "content": "full transcript text" }`,
      },
      {
        role: "user",
        content: `Partner name: ${partnerName}\n\nTranscript (first 15000 chars):\n\n${transcript.slice(0, 15000)}`,
      },
    ],
  })

  const parsed = JSON.parse(res.choices[0].message.content ?? "{}")
  return parsed as SpeakerDetectionResult
}

export async function extractSpeakerContent(
  transcript: string,
  speakerId: string,
  partnerName: string
): Promise<string> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `Extract ONLY the spoken lines from "${speakerId}" in this transcript. The user has confirmed this is ${partnerName}.
Remove all other speakers' lines, timestamps, and stage directions.
Return the extracted text as clean continuous prose — just their words, nothing else.`,
      },
      { role: "user", content: transcript.slice(0, 60000) },
    ],
  })
  return res.choices[0].message.content ?? transcript
}

// ─── Add Content ──────────────────────────────────────────────────────────────

export async function addContent(data: {
  partner: string
  sourceType: string
  sourceUrl?: string
  title?: string
  content: string
  publishedAt?: string
}) {
  const embedding = await embed(data.content)
  const tags = await generateTags(data.content)

  await prisma.partnerContent.create({
    data: {
      partner: data.partner,
      sourceType: data.sourceType,
      sourceUrl: data.sourceUrl || null,
      title: data.title || null,
      content: data.content,
      embedding,
      tags,
      publishedAt: data.publishedAt ? new Date(data.publishedAt) : null,
    },
  })

  await notifyZapier({
    partner: data.partner,
    sourceType: data.sourceType,
    title: data.title,
    content: data.content,
    tags,
    sourceUrl: data.sourceUrl,
    publishedAt: data.publishedAt ? new Date(data.publishedAt) : null,
  })

  await sendEmailReport(
    `New ${data.sourceType} added — ${data.partner}`,
    `<p><strong>Partner:</strong> ${data.partner}</p>
<p><strong>Type:</strong> ${data.sourceType}</p>
${data.title ? `<p><strong>Title:</strong> ${data.title}</p>` : ""}
<p><strong>Tags:</strong> ${tags.join(", ") || "none"}</p>
${data.sourceUrl ? `<p><strong>Source:</strong> <a href="${data.sourceUrl}">${data.sourceUrl}</a></p>` : ""}
<p><strong>Content preview:</strong></p>
<p style="color:#555">${data.content.slice(0, 500)}${data.content.length > 500 ? "…" : ""}</p>`
  )

  revalidatePath("/content-library")
}

// ─── Twitter Sync ─────────────────────────────────────────────────────────────

export async function syncTwitter(): Promise<{ ingested: number; skipped: number; errors: number }> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) throw new Error("TWITTER_BEARER_TOKEN not set")

  let ingested = 0
  let skipped = 0
  let errors = 0

  for (const [partner, config] of Object.entries(PARTNERS)) {
    try {
      // Find the last saved tweet for this partner to use as since_id
      const lastTweet = await prisma.partnerContent.findFirst({
        where: { partner, sourceType: "tweet" },
        orderBy: { publishedAt: "desc" },
        select: { sourceUrl: true },
      })

      // Extract tweet ID from sourceUrl e.g. https://twitter.com/lessin/status/1234567890
      const sinceId = lastTweet?.sourceUrl?.split("/status/")[1] ?? null

      // Get user ID from handle
      const userRes = await fetch(
        `https://api.twitter.com/2/users/by/username/${config.twitterHandle}?user.fields=id`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      )
      const userData = await userRes.json()
      const userId = userData?.data?.id
      if (!userId) { errors++; continue }

      // Fetch tweets since last save (or max 100 on first sync)
      const params = new URLSearchParams({
        max_results: "100",
        "tweet.fields": "created_at,text",
        exclude: "retweets,replies",
      })
      if (sinceId) params.set("since_id", sinceId)

      const tweetsRes = await fetch(
        `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      )
      const tweetsData = await tweetsRes.json()
      const tweets = tweetsData?.data || []

      for (const tweet of tweets) {
        const sourceUrl = `https://twitter.com/${config.twitterHandle}/status/${tweet.id}`
        if (tweet.text.length < 20) { skipped++; continue }

        const embedding = await embed(tweet.text)
        const tags = await generateTags(tweet.text)

        await prisma.partnerContent.create({
          data: {
            partner,
            sourceType: "tweet",
            sourceUrl,
            content: tweet.text,
            embedding,
            tags,
            publishedAt: tweet.created_at ? new Date(tweet.created_at) : null,
          },
        })

        await notifyZapier({
          partner,
          sourceType: "tweet",
          content: tweet.text,
          tags,
          sourceUrl,
          publishedAt: tweet.created_at ? new Date(tweet.created_at) : null,
        })

        ingested++
      }
    } catch {
      errors++
    }
  }

  if (ingested > 0) {
    await sendEmailReport(
      `Weekly X sync complete — ${ingested} new posts`,
      `<p>The weekly Twitter sync just finished.</p>
<ul>
<li><strong>New posts ingested:</strong> ${ingested}</li>
<li><strong>Skipped (too short):</strong> ${skipped}</li>
<li><strong>Errors:</strong> ${errors}</li>
</ul>
<p>View the full library at <a href="https://slow-hackathon.vercel.app/content-library">Content Library</a>.</p>`
    )
  }

  revalidatePath("/content-library")
  return { ingested, skipped, errors }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getContent(filters?: {
  partner?: string
  sourceType?: string
  tag?: string
}) {
  return prisma.partnerContent.findMany({
    where: {
      ...(filters?.partner && { partner: filters.partner }),
      ...(filters?.sourceType && { sourceType: filters.sourceType }),
      ...(filters?.tag && { tags: { has: filters.tag } }),
    },
    select: {
      id: true,
      partner: true,
      sourceType: true,
      sourceUrl: true,
      title: true,
      content: true,
      tags: true,
      publishedAt: true,
      createdAt: true,
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  })
}

export async function getAllTags(): Promise<string[]> {
  const rows = await prisma.partnerContent.findMany({ select: { tags: true } })
  const all = rows.flatMap(r => r.tags ?? [])
  return [...new Set(all)].sort()
}

export async function deleteContent(id: string) {
  await prisma.partnerContent.delete({ where: { id } })
  revalidatePath("/content-library")
}

export async function backfillTags(): Promise<{ updated: number; skipped: number }> {
  const untagged = await prisma.partnerContent.findMany({
    where: { tags: { isEmpty: true } },
    select: { id: true, content: true },
  })

  let updated = 0
  let skipped = 0

  for (const item of untagged) {
    try {
      const tags = await generateTags(item.content)
      if (tags.length === 0) { skipped++; continue }
      await prisma.partnerContent.update({
        where: { id: item.id },
        data: { tags },
      })
      updated++
    } catch {
      skipped++
    }
  }

  revalidatePath("/content-library")
  return { updated, skipped }
}
