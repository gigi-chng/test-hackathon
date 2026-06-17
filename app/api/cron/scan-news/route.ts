import { NextRequest, NextResponse } from "next/server"
import { scanNews } from "@/lib/actions/news-scanner"

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await scanNews()
  return NextResponse.json(result)
}
