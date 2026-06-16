import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export const maxDuration = 30

export async function GET(req: NextRequest) {
  // Auth check
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CONTENT_API_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const partner    = searchParams.get("partner")    ?? undefined
  const sourceType = searchParams.get("type")       ?? undefined
  const tag        = searchParams.get("tag")        ?? undefined
  const query      = searchParams.get("query")      ?? undefined
  const limit      = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200)

  const items = await prisma.partnerContent.findMany({
    where: {
      ...(partner    && { partner }),
      ...(sourceType && { sourceType }),
      ...(tag        && { tags: { has: tag } }),
      ...(query      && {
        OR: [
          { content: { contains: query, mode: "insensitive" } },
          { title:   { contains: query, mode: "insensitive" } },
          { tags:    { has: query.toLowerCase() } },
        ],
      }),
    },
    select: {
      id:          true,
      partner:     true,
      sourceType:  true,
      sourceUrl:   true,
      title:       true,
      content:     true,
      tags:        true,
      publishedAt: true,
      createdAt:   true,
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: limit,
  })

  return NextResponse.json({
    count: items.length,
    items,
  })
}
