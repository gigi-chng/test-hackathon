import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results: string[] = []

  const migrations: [string, string][] = [
    ["partner_content.tags",          `ALTER TABLE partner_content ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`],
    ["partner_content.manual",        `ALTER TABLE partner_content ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false`],
    ["partner_profiles.toneOfVoice",  `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "toneOfVoice" TEXT NOT NULL DEFAULT ''`],
    ["partner_profiles.pointOfView",  `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "pointOfView" TEXT NOT NULL DEFAULT ''`],
    ["partner_profiles.themes",       `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}'`],
    ["partner_profiles.styleNotes",   `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "styleNotes" TEXT NOT NULL DEFAULT ''`],
    ["partner_profiles.rawProfile",   `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "rawProfile" TEXT NOT NULL DEFAULT ''`],
    ["partner_profiles.generatedAt",  `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "generatedAt" TIMESTAMP WITH TIME ZONE`],
    ["post_drafts.scheduledAt",       `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP WITH TIME ZONE`],
    ["post_drafts.source",            `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent'`],
    ["post_drafts.platform",          `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'both'`],
    ["post_drafts.approvalToken",     `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS "approvalToken" TEXT`],
    ["post_drafts.videoId",           `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS "videoId" TEXT`],
    ["post_drafts.publishedAt",       `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP WITH TIME ZONE`],
    ["post_drafts.partnerCitation",   `ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS "partnerCitation" TEXT NOT NULL DEFAULT ''`],
    ["partner_profiles.createdAt",    `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`],
    ["partner_profiles.updatedAt",    `ALTER TABLE partner_profiles ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`],
  ]

  for (const [name, sql] of migrations) {
    try {
      await prisma.$executeRawUnsafe(sql)
      results.push(`${name}: OK`)
    } catch (err) {
      results.push(`${name}: ${String(err).slice(0, 100)}`)
    }
  }

  return NextResponse.json({ ok: true, results })
}
