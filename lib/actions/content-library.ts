"use server"

import * as cheerio from "cheerio"
import OpenAI from "openai"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"
import { PARTNERS } from "@/lib/partners"
import { generateTags } from "@/lib/ai/tags"

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

// One call for a whole page instead of one per item. Embedding 100 tweets
// individually is the main reason a backfill page would blow the 300s limit.
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts.map(t => t.slice(0, 8000)),
  })
  return res.data.map(d => d.embedding)
}

// Tagging is one call per item and can't be batched, so run it with bounded
// concurrency rather than sequentially.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

// Turn an X API failure into something a human can act on. The status code is
// the part that matters: 402 means the account is out of credits, 401 means the
// token is dead, 429 means slow down. Without it every failure reads the same.
function describeTwitterError(status: number, body: unknown): string {
  const b = body as { detail?: string; title?: string; errors?: { message?: string }[] } | null
  const detail =
    b?.detail ??
    b?.title ??
    b?.errors?.[0]?.message ??
    (status === 200 ? "no user in response" : "no detail returned")

  const hint =
    status === 402 ? " — top up the X API plan"
    : status === 401 ? " — TWITTER_BEARER_TOKEN is invalid or revoked"
    : status === 429 ? " — rate limited, will retry next run"
    : ""

  return `HTTP ${status}: ${detail}${hint}`
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

// ─── Press Quote Extraction ───────────────────────────────────────────────────

export async function extractPressQuotes(
  articleText: string,
  partnerName: string
): Promise<{ quotes: string; found: boolean }> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are extracting direct quotes from a press article.
Find every quote directly attributed to "${partnerName}" — these are their spoken or written words, usually in quotation marks with attribution like "said ${partnerName}" or "${partnerName} said".
Return ONLY the quotes themselves as clean prose, preserving the exact wording. Do not include journalist commentary, paraphrasing, or context sentences — only the verbatim quoted text.
If no quotes are found, return an empty string.`,
      },
      { role: "user", content: articleText.slice(0, 30000) },
    ],
  })
  const quotes = (res.choices[0].message.content ?? "").trim()
  return { quotes, found: quotes.length > 20 }
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
      manual: true,
      publishedAt: data.publishedAt ? new Date(data.publishedAt) : null,
    },
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

export async function syncTwitter(onlyPartner?: string): Promise<{
  ingested: number; skipped: number; duplicates: number; errors: number; errorDetail: string[]
}> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) throw new Error("TWITTER_BEARER_TOKEN not set")

  let ingested = 0
  let skipped = 0
  let duplicates = 0
  let errors = 0
  const errorDetail: string[] = []

  const partnerEntries = onlyPartner
    ? Object.entries(PARTNERS).filter(([key]) => key === onlyPartner)
    : Object.entries(PARTNERS)

  for (const [partner, config] of partnerEntries) {
    try {
      // Find the last saved tweet for this partner to use as since_id.
      // nulls: "last" is load-bearing — Postgres sorts NULLs FIRST on DESC, so
      // without it a single row with no publishedAt gets returned as "latest"
      // and since_id becomes an arbitrary old tweet.
      const lastTweet = await prisma.partnerContent.findFirst({
        where: { partner, sourceType: "tweet", publishedAt: { not: null } },
        orderBy: { publishedAt: { sort: "desc", nulls: "last" } },
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
      if (!userId) {
        // Surface why. A 402 (credits depleted), a revoked token and a genuinely
        // missing handle are three very different problems, and collapsing them
        // into a bare counter once cost us nine days of silent failures.
        errorDetail.push(
          `${partner}: user lookup failed — ${describeTwitterError(userRes.status, userData)}`,
        )
        errors++
        continue
      }

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

        // Belt and braces: since_id should already exclude these, but there is
        // no unique index on sourceUrl, so a bad since_id would otherwise
        // insert duplicates and report them as new.
        if (await alreadyIngested(sourceUrl)) { duplicates++; continue }

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

        ingested++
      }
    } catch (err) {
      console.error(`[syncTwitter] error for ${partner}:`, err)
      errorDetail.push(`${partner}: ${err instanceof Error ? err.message : String(err)}`)
      errors++
    }
  }

  // Report on failures too. Previously this only fired when ingested > 0, so a
  // partner that silently ingested nothing sent no email at all — which reads
  // as "nothing new" rather than "broken".
  if (ingested > 0 || errors > 0) {
    const who = onlyPartner ?? "all partners"
    await sendEmailReport(
      errors > 0
        ? `X sync (${who}) — ${ingested} new, ${errors} error${errors === 1 ? "" : "s"}`
        : `X sync (${who}) — ${ingested} new post${ingested === 1 ? "" : "s"}`,
      `<p>Twitter sync finished for <strong>${who}</strong>.</p>
<ul>
<li><strong>New posts ingested:</strong> ${ingested}</li>
<li><strong>Skipped (too short):</strong> ${skipped}</li>
<li><strong>Skipped (already had it):</strong> ${duplicates}</li>
<li><strong>Errors:</strong> ${errors}</li>
</ul>
${errorDetail.length ? `<p><strong>Error detail:</strong></p><ul>${errorDetail.map(e => `<li>${e}</li>`).join("")}</ul>` : ""}
<p>View the full library at <a href="https://slow-hackathon.vercel.app/content-library">Content Library</a>.</p>`
    )
  }

  revalidatePath("/content-library")
  return { ingested, skipped, duplicates, errors, errorDetail }
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
      manual: true,
      publishedAt: true,
      createdAt: true,
    },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
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

// ─── Twitter Backfill ─────────────────────────────────────────────────────────
//
// syncTwitter only walks forward (since_id), so the library starts wherever the
// first sync happened to run. This walks backward instead (until_id), one page
// per partner per run, so history fills in over several days without any single
// invocation hitting the 300s function limit.

type BackfillPartnerResult = {
  partner: string
  added: number
  duplicates: number
  tooShort: number
  oldestDate: string | null
  exhausted: boolean
  error?: string
}

export async function backfillTwitter(onlyPartner?: string): Promise<{
  results: BackfillPartnerResult[]
  totalAdded: number
  allExhausted: boolean
}> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN
  if (!bearerToken) throw new Error("TWITTER_BEARER_TOKEN not set")
  const started = Date.now()
  const BUDGET_MS = 240_000 // leave headroom under the 300s cap

  const entries = onlyPartner
    ? Object.entries(PARTNERS).filter(([k]) => k === onlyPartner)
    : Object.entries(PARTNERS)

  const results: BackfillPartnerResult[] = []

  for (const [partner, config] of entries) {
    const r: BackfillPartnerResult = {
      partner, added: 0, duplicates: 0, tooShort: 0, oldestDate: null, exhausted: false,
    }
    if (Date.now() - started > BUDGET_MS) {
      r.error = "skipped — ran out of time this run, will resume next run"
      results.push(r)
      continue
    }

    try {
      // Anchor on the oldest tweet we already hold. Snowflake IDs are numeric,
      // so compare as BigInt — string sort gets this wrong across digit counts.
      const stored = await prisma.partnerContent.findMany({
        where: { partner, sourceType: "tweet", sourceUrl: { not: null } },
        select: { sourceUrl: true },
      })
      const ids = stored
        .map(s => s.sourceUrl?.split("/status/")[1])
        .filter((v): v is string => !!v && /^\d+$/.test(v))
      if (!ids.length) {
        r.error = "no stored tweets to anchor from; run the forward sync first"
        results.push(r)
        continue
      }
      const untilId = ids.reduce((min, id) => (BigInt(id) < BigInt(min) ? id : min))

      const userRes = await fetch(
        `https://api.twitter.com/2/users/by/username/${config.twitterHandle}?user.fields=id`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      )
      const userBody = await userRes.json()
      const userId = userBody?.data?.id
      if (!userId) {
        r.error = `user lookup failed — ${describeTwitterError(userRes.status, userBody)}`
        results.push(r)
        continue
      }

      const params = new URLSearchParams({
        max_results: "100",
        "tweet.fields": "created_at,text",
        exclude: "retweets,replies",
        until_id: untilId,
      })
      const res = await fetch(
        `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      )
      const data = await res.json()
      if (data?.errors || data?.title) {
        r.error = JSON.stringify(data).slice(0, 200)
        results.push(r)
        continue
      }

      const tweets: { id: string; text: string; created_at?: string }[] = data?.data ?? []
      // No next_token means we've reached the end of what the API will return.
      r.exhausted = tweets.length === 0 || !data?.meta?.next_token

      const fresh: typeof tweets = []
      for (const t of tweets) {
        if (t.text.length < 20) { r.tooShort++; continue }
        const url = `https://twitter.com/${config.twitterHandle}/status/${t.id}`
        if (await alreadyIngested(url)) { r.duplicates++; continue }
        fresh.push(t)
      }

      if (fresh.length) {
        const [embeddings, tagSets] = await Promise.all([
          embedBatch(fresh.map(t => t.text)),
          mapLimit(fresh, 8, t => generateTags(t.text)),
        ])
        await prisma.partnerContent.createMany({
          data: fresh.map((t, i) => ({
            partner,
            sourceType: "tweet",
            sourceUrl: `https://twitter.com/${config.twitterHandle}/status/${t.id}`,
            content: t.text,
            embedding: embeddings[i],
            tags: tagSets[i],
            publishedAt: t.created_at ? new Date(t.created_at) : null,
          })),
        })
        r.added = fresh.length
        const dates = fresh.map(t => t.created_at).filter(Boolean).sort() as string[]
        r.oldestDate = dates[0]?.slice(0, 10) ?? null
      }
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err)
    }
    results.push(r)
  }

  const totalAdded = results.reduce((n, r) => n + r.added, 0)
  // "Complete" must mean the API confirmed there is nothing older, never that a
  // partner errored. Counting failures as done meant a total outage produced a
  // "backfill complete — you can remove the cron" email.
  const anyFailed = results.some(r => !!r.error)
  const allExhausted = !anyFailed && results.every(r => r.exhausted)

  // Progress recap after every run, whether or not anything landed.
  const totals = await prisma.partnerContent.groupBy({
    by: ["partner"],
    where: { sourceType: "tweet" },
    _count: { id: true },
  })
  const totalMap = Object.fromEntries(totals.map(t => [t.partner, t._count.id]))

  const rows = results.map(r => {
    const status = r.error
      ? `<span style="color:#b00">${r.error}</span>`
      : r.exhausted
        ? "complete — no older tweets remain"
        : "more history available"
    return `<tr>
<td style="padding:4px 10px 4px 0"><strong>${r.partner}</strong></td>
<td style="padding:4px 10px 4px 0">+${r.added}</td>
<td style="padding:4px 10px 4px 0">${totalMap[r.partner] ?? 0} total</td>
<td style="padding:4px 10px 4px 0">${r.oldestDate ? `back to ${r.oldestDate}` : "—"}</td>
<td style="padding:4px 10px 4px 0">${status}</td>
</tr>`
  }).join("")

  await sendEmailReport(
    allExhausted
      ? `Twitter backfill complete — ${totalAdded} added on the final run`
      : `Twitter backfill — ${totalAdded} tweets added`,
    `<p>Backfill run finished. It walks backward one page per partner per day, so this repeats until every partner is complete.</p>
<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">
<tr style="text-align:left;border-bottom:1px solid #ddd">
<th style="padding:4px 10px 4px 0">Partner</th><th style="padding:4px 10px 4px 0">Added</th>
<th style="padding:4px 10px 4px 0">Library</th><th style="padding:4px 10px 4px 0">Reached</th>
<th style="padding:4px 10px 4px 0">Status</th></tr>
${rows}
</table>
<p>${allExhausted
  ? "<strong>Every partner is now fully backfilled.</strong> You can remove the backfill cron from vercel.json."
  : "Another page runs tomorrow."}</p>
<p>Skipped this run: ${results.reduce((n, r) => n + r.duplicates, 0)} already in the library, ${results.reduce((n, r) => n + r.tooShort, 0)} too short.</p>`
  )

  revalidatePath("/content-library")
  return { results, totalAdded, allExhausted }
}
