import { NextRequest, NextResponse } from "next/server"
import { ingestPartnerBlog } from "@/lib/actions/ingest"
import { PARTNERS, type Partner } from "@/lib/partners"

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const only = req.nextUrl.searchParams.get("partner")
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "40"), 100)

  const partners = (only ? [only] : Object.keys(PARTNERS)).filter(
    p => p in PARTNERS
  ) as Partner[]

  const results: Record<string, unknown> = {}

  for (const partner of partners) {
    try {
      results[partner] = await ingestPartnerBlog(partner, limit)
    } catch (err) {
      console.error(`[ingest-blogs] ${partner}:`, err)
      results[partner] = { error: String(err) }
    }
  }

  return NextResponse.json({ ok: true, results })
}
