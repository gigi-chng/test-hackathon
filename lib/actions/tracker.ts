"use server"

import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"

export async function getProjects() {
  return prisma.trackerProject.findMany({
    where: { status: { not: "archived" } },
    include: {
      kpis: true,
      weeklyGoals: { orderBy: [{ rankOrder: "asc" }, { createdAt: "asc" }] },
      updates: { orderBy: { createdAt: "desc" } },
    },
    orderBy: [{ vertical: "asc" }, { order: "asc" }],
  })
}

export async function createProject(data: {
  vertical: string
  name: string
  description?: string
}) {
  await prisma.trackerProject.create({ data })
  revalidatePath("/tracker")
}

export async function updateProjectStatus(id: string, status: string) {
  await prisma.trackerProject.update({ where: { id }, data: { status } })
  revalidatePath("/tracker")
}

export async function upsertKPI(data: {
  id?: string
  projectId: string
  name: string
  unit?: string
  target?: number
  current?: number
  stage?: string
}) {
  if (data.id) {
    await prisma.trackerKPI.update({
      where: { id: data.id },
      data: { current: data.current, target: data.target, unit: data.unit, name: data.name },
    })
  } else {
    await prisma.trackerKPI.create({ data })
  }
  revalidatePath("/tracker")
}

export async function deleteKPI(id: string) {
  await prisma.trackerKPI.delete({ where: { id } })
  revalidatePath("/tracker")
}

export async function toggleGoalStage(id: string, stage: string) {
  await prisma.trackerKPI.update({ where: { id }, data: { stage } })
  revalidatePath("/tracker")
}

export async function upsertGoal(data: {
  id?: string
  projectId: string
  weekOf: Date
  text: string
  type?: string
  workType?: string
  priority?: string
  rankOrder?: number
  targetValue?: number
  actualValue?: number
  completed?: boolean
  notes?: string
}) {
  if (data.id) {
    await prisma.trackerGoal.update({
      where: { id: data.id },
      data: {
        text: data.text,
        completed: data.completed,
        workType: data.workType,
        priority: data.priority,
        rankOrder: data.rankOrder,
        actualValue: data.actualValue,
        targetValue: data.targetValue,
        notes: data.notes,
      },
    })
  } else {
    await prisma.trackerGoal.create({ data })
  }
  revalidatePath("/tracker")
}

export async function updateGoalMeta(id: string, data: { priority?: string; workType?: string; rankOrder?: number }) {
  await prisma.trackerGoal.update({ where: { id }, data })
  revalidatePath("/tracker")
}

export async function reorderGoals(updates: { id: string; rankOrder: number }[]) {
  await Promise.all(updates.map(u => prisma.trackerGoal.update({ where: { id: u.id }, data: { rankOrder: u.rankOrder } })))
  revalidatePath("/tracker")
}

export async function reorderProjects(updates: { id: string; order: number }[]) {
  await Promise.all(updates.map(u => prisma.trackerProject.update({ where: { id: u.id }, data: { order: u.order } })))
  revalidatePath("/tracker")
}

export async function toggleGoal(id: string, completed: boolean) {
  await prisma.trackerGoal.update({ where: { id }, data: { completed } })
  revalidatePath("/tracker")
}

export async function deleteGoal(id: string) {
  await prisma.trackerGoal.delete({ where: { id } })
  revalidatePath("/tracker")
}

export async function addUpdate(projectId: string, text: string) {
  await prisma.trackerUpdate.create({ data: { projectId, text } })
  revalidatePath("/tracker")
}

export async function seedDefaultProjects() {
  const existing = await prisma.trackerProject.count()
  if (existing > 0) return

  const projects = [
    // Slow
    { vertical: "slow", name: "Merch Gifting", order: 0 },
    { vertical: "slow", name: "LinkedIn Agent", order: 1 },
    { vertical: "slow", name: "Snail Mail", order: 2 },
    { vertical: "slow", name: "X", order: 3 },
    // Slow Creator
    { vertical: "slow-creator", name: "Content Calendar", order: 0 },
    { vertical: "slow-creator", name: "Hackathon", order: 1 },
    { vertical: "slow-creator", name: "Announcements", order: 2 },
    // Sam
    { vertical: "sam", name: "Weekly More or Less Upload", order: 0 },
  ]

  await prisma.trackerProject.createMany({ data: projects })
}
