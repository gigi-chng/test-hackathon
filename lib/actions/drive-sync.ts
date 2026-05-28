"use server"

import OpenAI from "openai"
import { prisma } from "@/lib/db/prisma"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

const PARTNER_PATTERNS: [string, RegExp][] = [
  ["sam",   /\bsam\b|\blessin\b/i],
  ["will",  /\bwill\b|\bquist\b/i],
  ["yoni",  /\byoni\b|\brechtman\b/i],
  ["megan", /\bmegan\b|\blightcap\b/i],
]

function inferPartner(filename: string, folderName: string): string {
  const text = `${folderName} ${filename}`
  for (const [key, pattern] of PARTNER_PATTERNS) {
    if (pattern.test(text)) return key
  }
  return "unknown"
}

function cleanTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim()
}

type DriveFile = { id: string; name: string; folderName: string }

async function listFolderFiles(folderId: string, apiKey: string, folderName = ""): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "100",
      key: apiKey,
    })
    if (pageToken) params.set("pageToken", pageToken)

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`)
    if (!res.ok) throw new Error(`Drive API error: ${res.status} ${await res.text()}`)
    const data = await res.json()

    for (const item of data.files ?? []) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        const sub = await listFolderFiles(item.id, apiKey, item.name)
        files.push(...sub)
      } else if (item.mimeType?.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(item.name)) {
        files.push({ id: item.id, name: item.name, folderName })
      }
    }

    pageToken = data.nextPageToken
  } while (pageToken)

  return files
}

export async function syncDriveFolder(): Promise<{ added: number; skipped: number; message?: string }> {
  // API key can come from env OR from the DB (set via in-app settings)
  const { prisma: db } = await import("@/lib/db/prisma")
  const dbApiKey = await db.appSetting.findUnique({ where: { key: "GOOGLE_API_KEY" } })

  const apiKey = process.env.GOOGLE_API_KEY || dbApiKey?.value
  const folderId = process.env.DRIVE_VIDEO_FOLDER_ID

  if (!apiKey) {
    return { added: 0, skipped: 0, message: "MISSING_API_KEY" }
  }
  if (!folderId) {
    return { added: 0, skipped: 0, message: "Add DRIVE_VIDEO_FOLDER_ID to your environment variables" }
  }

  const [driveFiles, existing] = await Promise.all([
    listFolderFiles(folderId, apiKey),
    prisma.videoLibrary.findMany({ select: { storageUrl: true } }),
  ])

  const existingFileIds = new Set(
    existing.map(v => v.storageUrl.match(/\/d\/([^/?]+)/)?.[1]).filter(Boolean)
  )

  let added = 0, skipped = 0

  for (const file of driveFiles) {
    if (existingFileIds.has(file.id)) { skipped++; continue }

    const title = cleanTitle(file.name)
    const partner = inferPartner(file.name, file.folderName)
    const storageUrl = `https://drive.google.com/file/d/${file.id}/view?usp=sharing`
    const embedding = await embed(title)

    await prisma.videoLibrary.create({
      data: {
        partner,
        title,
        storageUrl,
        topics: [],
        embedding,
        transcript: null,
      },
    })

    added++
  }

  return { added, skipped }
}
