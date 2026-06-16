import { NextRequest, NextResponse } from "next/server"
import { generatePartnerProfiles } from "@/lib/actions/partner-profiles"

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await generatePartnerProfiles()
  return NextResponse.json(result)
}
