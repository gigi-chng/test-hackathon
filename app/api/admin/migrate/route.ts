import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ?inspect=1 reports what this database actually has, without changing it.
  // Runs on DATABASE_URL, so it is a direct read of production.
  if (req.nextUrl.searchParams.get("inspect") === "1") {
    const indexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'partner_content' ORDER BY indexname`
    )
    const [counts] = await prisma.$queryRawUnsafe<{ rows: bigint }[]>(
      `SELECT count(*) AS rows FROM partner_content`
    )
    return NextResponse.json({
      ok: true,
      rows: Number(counts.rows),
      indexes: indexes.map(i => i.indexname),
    })
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
    ["partner_profiles.displayName nullable", `ALTER TABLE partner_profiles ALTER COLUMN "displayName" DROP NOT NULL`],
    ["partner_profiles.displayName default",  `ALTER TABLE partner_profiles ALTER COLUMN "displayName" SET DEFAULT ''`],
    // Indexes have to come through here too. The build's prisma db push runs
    // against DIRECT_URL, which points at the dev project, so schema changes
    // made at build time never reach this database.
    ["partner_content.sourceUrl idx", `CREATE INDEX IF NOT EXISTS "partner_content_sourceUrl_idx" ON partner_content("sourceUrl")`],
    ["media_appearances.verifyToken backfill", `UPDATE media_appearances SET "verifyToken" = gen_random_uuid()::text WHERE "verifyToken" IS NULL`],
    ["partner_content.lookup idx",    `CREATE INDEX IF NOT EXISTS "partner_content_partner_sourceType_publishedAt_idx" ON partner_content(partner, "sourceType", "publishedAt")`],
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
