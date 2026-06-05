import { NextRequest, NextResponse } from "next/server"

export async function GET(req: NextRequest) {
  // Auto-posting disabled — all posts require manual Telegram approval
  return NextResponse.json({ ok: true, message: "Auto-posting disabled" })
}
