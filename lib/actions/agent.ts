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
