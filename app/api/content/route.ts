import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"
import { addContent } from "@/lib/actions/content-library"

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
    orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: limit,
  })

  return NextResponse.json({
    count: items.length,
    items,
  })
}

// Write path for content the scrapers can't reach — press hits, podcast
// appearances, anything gathered by hand. Accepts one item or an array.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CONTENT_API_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const items = Array.isArray(body) ? body : [body]
  const results: { sourceUrl?: string; status: string; error?: string }[] = []

  for (const raw of items) {
    const item = raw as Record<string, string | undefined>
    if (!item?.partner || !item?.sourceType || !item?.content) {
      results.push({
        sourceUrl: item?.sourceUrl,
        status: "skipped",
        error: "partner, sourceType and content are all required",
      })
      continue
    }

    // Same URL guard the scrapers use, so re-running this is safe.
    if (item.sourceUrl) {
      const dupe = await prisma.partnerContent.findFirst({
        where: { sourceUrl: item.sourceUrl },
        select: { id: true },
      })
      if (dupe) {
        results.push({ sourceUrl: item.sourceUrl, status: "duplicate" })
        continue
      }
    }

    try {
      await addContent({
        partner: item.partner,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        title: item.title,
        content: item.content,
        publishedAt: item.publishedAt,
      })
      results.push({ sourceUrl: item.sourceUrl, status: "added" })
    } catch (err) {
      results.push({
        sourceUrl: item.sourceUrl,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return NextResponse.json({
    ok: true,
    added: results.filter(r => r.status === "added").length,
    duplicates: results.filter(r => r.status === "duplicate").length,
    errors: results.filter(r => r.status === "error").length,
    results,
  })
}
