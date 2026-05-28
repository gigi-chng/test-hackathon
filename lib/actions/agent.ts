"use server"

import { prisma } from "@/lib/db/prisma"
import { runAgentPipeline, scheduleVideoQueue as runScheduleVideoQueue } from "@/lib/actions/trends"
import { syncDriveFolder as runDriveSync } from "@/lib/actions/drive-sync"

export async function syncDriveFolder() {
  return runDriveSync()
}

export async function getPendingDrafts() {
  return prisma.postDraft.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  })
}

export async function getAllDrafts() {
  return prisma.postDraft.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
  })
}

export async function getContentCount() {
  return prisma.partnerContent.groupBy({
    by: ["partner"],
    _count: { id: true },
  })
}

export async function triggerPipeline() {
  return runAgentPipeline()
}

export async function getVideoLibraryStatus() {
  const [videos, usedDrafts] = await Promise.all([
    prisma.videoLibrary.findMany({
      select: { id: true, partner: true, title: true, forcedNext: true, uploadedAt: true },
      orderBy: { uploadedAt: "asc" },
    }),
    prisma.postDraft.findMany({
      where: { status: { in: ["approved", "published", "scheduled", "pending"] }, videoId: { not: null } },
      select: { videoId: true, status: true, publishedAt: true },
    }),
  ])

  const usedMap = new Map<string, { status: string; publishedAt: Date | null }>()
  for (const d of usedDrafts) {
    if (d.videoId && !usedMap.has(d.videoId)) {
      usedMap.set(d.videoId, { status: d.status, publishedAt: d.publishedAt })
    }
  }

  return videos.map(v => ({
    id: v.id,
    partner: v.partner,
    title: v.title,
    forcedNext: v.forcedNext,
    posted: usedMap.has(v.id),
    publishedAt: usedMap.get(v.id)?.publishedAt ?? null,
  }))
}

export async function scheduleVideoQueue() {
  return runScheduleVideoQueue()
}

export async function getVideoDrafts() {
  const drafts = await prisma.postDraft.findMany({
    where: { source: "video" },
    orderBy: [{ status: "asc" }, { scheduledAt: "asc" }, { createdAt: "desc" }],
  })

  const videoIds = drafts.map(d => d.videoId).filter(Boolean) as string[]
  const videos = videoIds.length > 0
    ? await prisma.videoLibrary.findMany({
        where: { id: { in: videoIds } },
        select: { id: true, title: true, storageUrl: true },
      })
    : []

  const videoMap = new Map(videos.map(v => [v.id, v]))

  return drafts.map(d => ({
    ...d,
    videoTitle: d.videoId ? (videoMap.get(d.videoId)?.title ?? null) : null,
    videoStorageUrl: d.videoId ? (videoMap.get(d.videoId)?.storageUrl ?? null) : null,
  }))
}

export async function approveVideoDraft(id: string) {
  // Find the latest scheduled slot already taken
  const lastScheduled = await prisma.postDraft.findFirst({
    where: { status: "scheduled", scheduledAt: { not: null } },
    orderBy: { scheduledAt: "desc" },
    select: { scheduledAt: true },
  })

  // Next slot: start from the later of (tomorrow) or (last slot + ~12h)
  const base = lastScheduled?.scheduledAt
    ? new Date(Math.max(lastScheduled.scheduledAt.getTime() + 12 * 60 * 60 * 1000, Date.now() + 60 * 60 * 1000))
    : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(16, 0, 0, 0); return d })()

  // Advance to next weekday at 9am or 2pm PT
  const date = new Date(base)
  const hours = date.getUTCHours()
  // Snap to either 16:00 UTC (9am PT) or 21:00 UTC (2pm PT)
  if (hours < 16) {
    date.setUTCHours(16, 0, 0, 0)
  } else if (hours < 21) {
    date.setUTCHours(21, 0, 0, 0)
  } else {
    date.setDate(date.getDate() + 1)
    date.setUTCHours(16, 0, 0, 0)
  }
  // Skip weekends
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1)
  }

  return prisma.postDraft.update({
    where: { id },
    data: { status: "scheduled", scheduledAt: date },
  })
}

export async function updateDraft(id: string, data: { hook?: string; body?: string; scheduledAt?: Date }) {
  return prisma.postDraft.update({ where: { id }, data })
}

export async function rewriteDraftWithAI(id: string, instruction: string): Promise<{ hook: string; body: string }> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const draft = await prisma.postDraft.findUnique({
    where: { id },
    select: { hook: true, body: true, partner: true, partnerCitation: true, videoId: true },
  })
  if (!draft) throw new Error("Draft not found")

  const video = draft.videoId
    ? await prisma.videoLibrary.findUnique({
        where: { id: draft.videoId },
        select: { title: true, transcript: true },
      })
    : null

  const partnerNames: Record<string, string> = {
    sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
  }
  const partnerHandles: Record<string, string> = {
    sam: "@lessin", will: "@wquist", yoni: "@yrechtman", megan: "@mmlightcap",
  }
  const name = partnerNames[draft.partner] || draft.partner
  const handle = partnerHandles[draft.partner] || ""

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1800,
    messages: [{
      role: "user",
      content: `You are editing social media drafts for ${name} at Slow Ventures.

CURRENT TWITTER DRAFT:
${draft.hook}

CURRENT LINKEDIN DRAFT:
${draft.body}

${video?.transcript ? `VIDEO TRANSCRIPT (for reference):\n${video.transcript.slice(0, 2000)}\n` : ""}
${draft.partnerCitation ? `KEY QUOTE FROM VIDEO:\n"${draft.partnerCitation}"\n` : ""}

EDIT INSTRUCTION:
${instruction}

Apply the edit instruction to both the Twitter and LinkedIn drafts. Keep what works, change what was asked. Stay in ${name.split(" ")[0]}'s voice. Hard rules: no em dashes, no hashtags, no emojis, no questions at the end, Twitter under 220 characters (not counting the handle).

Return ONLY valid JSON:
{ "twitter": "...", "linkedin": "..." }`,
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
  }
}

export async function deleteDraft(id: string) {
  return prisma.postDraft.delete({ where: { id } })
}

export async function publishNow(id: string) {
  const { publishDraft } = await import("@/lib/actions/publish")
  const draft = await prisma.postDraft.findUnique({ where: { id } })
  if (!draft) throw new Error("Draft not found")
  return publishDraft(draft)
}

export async function forceNextVideo(id: string) {
  // Clear any existing forced video first
  await prisma.videoLibrary.updateMany({ where: { forcedNext: true }, data: { forcedNext: false } })
  await prisma.videoLibrary.update({ where: { id }, data: { forcedNext: true } })
}
