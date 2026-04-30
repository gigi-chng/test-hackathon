import { NextRequest, NextResponse } from "next/server"
import { runAgentPipeline } from "@/lib/actions/trends"

export async function GET(req: NextRequest) {
  // Verify this is called by Vercel Cron
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await runAgentPipeline()
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error("Agent pipeline error:", e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
