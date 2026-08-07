import { NextRequest, NextResponse } from "next/server"
import { backfillTwitter } from "@/lib/actions/content-library"

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const partner = req.nextUrl.searchParams.get("partner") ?? undefined

  try {
    const result = await backfillTwitter(partner)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
