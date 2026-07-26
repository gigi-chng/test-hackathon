import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results: string[] = []

  // Add tags column to partner_content if missing
  try {
    await prisma.$executeRaw`ALTER TABLE partner_content ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`
    results.push("partner_content.tags: OK")
  } catch (err) {
    results.push(`partner_content.tags: ${err}`)
  }

  // Add manual column to partner_content if missing
  try {
    await prisma.$executeRaw`ALTER TABLE partner_content ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false`
    results.push("partner_content.manual: OK")
  } catch (err) {
    results.push(`partner_content.manual: ${err}`)
  }

  return NextResponse.json({ ok: true, results })
}
