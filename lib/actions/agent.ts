"use server"

import { prisma } from "@/lib/db/prisma"
import { runAgentPipeline } from "@/lib/actions/trends"

export async function getPendingDrafts() {
  return prisma.postDraft.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  })
}

export async function getAllDrafts() {
  return prisma.postDraft.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
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
      where: { status: { in: ["approved", "published"] }, videoId: { not: null } },
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

export async function forceNextVideo(id: string) {
  // Clear any existing forced video first
  await prisma.videoLibrary.updateMany({ where: { forcedNext: true }, data: { forcedNext: false } })
  await prisma.videoLibrary.update({ where: { id }, data: { forcedNext: true } })
}
