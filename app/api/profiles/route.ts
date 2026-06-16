import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CONTENT_API_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const partner = searchParams.get("partner") ?? undefined

  const profiles = await prisma.partnerProfile.findMany({
    where: partner ? { partner } : undefined,
    select: {
      partner:     true,
      toneOfVoice: true,
      pointOfView: true,
      themes:      true,
      styleNotes:  true,
      rawProfile:  true,
      generatedAt: true,
      updatedAt:   true,
    },
    orderBy: { partner: "asc" },
  })

  return NextResponse.json({ count: profiles.length, profiles })
}
