"use server"

import * as cheerio from "cheerio"
import Anthropic from "@anthropic-ai/sdk"
import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type MediaAppearance = {
  id: string
  partner: string
  type: string
  show: string
  title: string
  url: string
  publishedAt: Date | null
  transcript: string | null
  topics: string[]
  notes: string | null
  status: string
  processingJobId: string | null
  createdAt: Date
}

// ─── URL detection ────────────────────────────────────────────────────────────

function isAudioUrl(url: string): boolean {
  const audioDomains = [
    "youtube.com", "youtu.be", "spotify.com", "podcasts.apple.com",
    "buzzsprout.com", "soundcloud.com", "simplecast.com",
    "transistor.fm", "anchor.fm", "podbean.com",
  ]
  const audioExts = /\.(mp3|mp4|m4a|wav|ogg|aac|mov|webm)(\?|$)/i
  const lower = url.toLowerCase()
  return audioDomains.some(d => lower.includes(d)) || audioExts.test(lower)
}

// ─── Text scraper ─────────────────────────────────────────────────────────────

async function scrapeText(url: string): Promise<string> {
  const res = await fetch(url, {
    next: { revalidate: 0 },
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SlowVenturesBot/1.0)" },
  })
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)
  $("nav, footer, script, style, header, aside, .sidebar, .ad").remove()
  for (const sel of ["article", "main", ".post-content", ".entry-content", ".article-body", ".content"]) {
    const text = $(sel).text().replace(/\s+/g, " ").trim()
    if (text.length > 300) return text.slice(0, 30000)
  }
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 30000)
}

// ─── AssemblyAI: submit job ───────────────────────────────────────────────────

async function submitTranscription(url: string): Promise<string> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY not set")
  const res = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: url, speech_model: "best" }),
  })
  if (!res.ok) throw new Error(`AssemblyAI submit failed: ${await res.text()}`)
  const { id } = await res.json()
  return id as string
}

// ─── AssemblyAI: poll job ─────────────────────────────────────────────────────

async function pollTranscription(jobId: string): Promise<{ status: string; text?: string; error?: string }> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY not set")
  const res = await fetch(`https://api.assemblyai.com/v2/transcript/${jobId}`, {
    headers: { Authorization: apiKey },
  })
  if (!res.ok) throw new Error(`AssemblyAI poll failed: ${res.status}`)
  const data = await res.json()
  return { status: data.status, text: data.text, error: data.error }
}

// ─── Topic extraction ─────────────────────────────────────────────────────────

async function extractTopics(text: string, title: string): Promise<string[]> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `Extract 3-5 topic tags from this content. Return ONLY a JSON array of short lowercase strings (1-3 words each).

Title: ${title}
Content: ${text.slice(0, 1500)}

Example output: ["ai adoption", "venture capital", "founder advice"]
Return ONLY the JSON array, nothing else.`,
      }],
    })
    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "[]"
    const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed.slice(0, 6).map(String) : []
  } catch {
    return []
  }
}

// ─── Add appearance ───────────────────────────────────────────────────────────

export async function addMediaAppearance(input: {
  partner: string
  type: string
  show: string
  title: string
  url: string
  publishedAt?: string
  notes?: string
}) {
  const audio = isAudioUrl(input.url)

  if (audio) {
    // Submit to AssemblyAI, return immediately — user polls for status
    let jobId: string | null = null
    try {
      jobId = await submitTranscription(input.url)
    } catch {
      // Can't submit (unsupported URL type, etc.) — store without transcript
    }

    const record = await prisma.mediaAppearance.create({
      data: {
        partner: input.partner,
        type: input.type,
        show: input.show,
        title: input.title,
        url: input.url,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        notes: input.notes ?? null,
        topics: [],
        status: jobId ? "processing" : "ready",
        processingJobId: jobId,
      },
    })
    revalidatePath("/media-tracker")
    return { id: record.id, processing: !!jobId }
  } else {
    // Scrape text synchronously
    let transcript = ""
    let topics: string[] = []
    let status = "ready"
    try {
      transcript = await scrapeText(input.url)
      topics = await extractTopics(transcript, input.title)
    } catch {
      status = "error"
    }

    const record = await prisma.mediaAppearance.create({
      data: {
        partner: input.partner,
        type: input.type,
        show: input.show,
        title: input.title,
        url: input.url,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        notes: input.notes ?? null,
        transcript: transcript || null,
        topics,
        status,
      },
    })
    revalidatePath("/media-tracker")
    return { id: record.id, processing: false }
  }
}

// ─── Check transcription status ───────────────────────────────────────────────

export async function checkTranscriptionStatus(id: string) {
  const record = await prisma.mediaAppearance.findUnique({ where: { id } })
  if (!record || !record.processingJobId) return

  const result = await pollTranscription(record.processingJobId)

  if (result.status === "completed" && result.text) {
    const topics = await extractTopics(result.text, record.title)
    await prisma.mediaAppearance.update({
      where: { id },
      data: { transcript: result.text, topics, status: "ready", processingJobId: null },
    })
  } else if (result.status === "error") {
    await prisma.mediaAppearance.update({
      where: { id },
      data: { status: "error", processingJobId: null },
    })
  }

  revalidatePath("/media-tracker")
}

// ─── Get appearances ──────────────────────────────────────────────────────────

export async function getMediaAppearances() {
  return prisma.mediaAppearance.findMany({
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  })
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteMediaAppearance(id: string) {
  await prisma.mediaAppearance.delete({ where: { id } })
  revalidatePath("/media-tracker")
}

// ─── Update notes/topics ──────────────────────────────────────────────────────

export async function updateMediaAppearance(id: string, data: { notes?: string; topics?: string[] }) {
  await prisma.mediaAppearance.update({ where: { id }, data })
  revalidatePath("/media-tracker")
}
