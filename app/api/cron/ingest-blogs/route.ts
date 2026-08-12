import { NextRequest, NextResponse } from "next/server"
import { ingestPartnerBlog, type BlogIngestResult } from "@/lib/actions/ingest"
import { sendIngestReport } from "@/lib/actions/ingest-report"
import { PARTNERS, type Partner } from "@/lib/partners"

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const only = req.nextUrl.searchParams.get("partner")
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "40"), 100)
  // Re-reads stored posts and corrects dates/tags written by earlier versions
  // of the scraper. Off by default: it refetches every page.
  const repair = req.nextUrl.searchParams.get("repair") === "1"

  const partners = (only ? [only] : Object.keys(PARTNERS)).filter(
    p => p in PARTNERS
  ) as Partner[]

  const results: Record<string, BlogIngestResult & { error?: string }> = {}

  for (const partner of partners) {
    try {
      results[partner] = await ingestPartnerBlog(partner, limit, repair)
    } catch (err) {
      console.error(`[ingest-blogs] ${partner}:`, err)
      results[partner] = {
        ingested: 0,
        skipped: 0,
        errors: 1,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // This job used to return JSON to a cron nobody reads, so Sam's blog sat at
  // zero rows indefinitely without anyone finding out.
  await sendIngestReport(results, repair)

  return NextResponse.json({ ok: true, repair, results })
}
