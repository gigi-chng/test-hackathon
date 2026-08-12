import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export const maxDuration = 60

// Read and write the media appearance tracker. Writes go straight to Prisma
// rather than through addMediaAppearance() so a bulk press import doesn't
// kick off a transcription job per row.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CONTENT_API_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const partner = req.nextUrl.searchParams.get("partner") ?? undefined
  const type = req.nextUrl.searchParams.get("type") ?? undefined
  const since = req.nextUrl.searchParams.get("since")
  const until = req.nextUrl.searchParams.get("until")

  const items = await prisma.mediaAppearance.findMany({
    where: {
      ...(partner && { partner }),
      ...(type && { type }),
      ...((since || until) && {
        publishedAt: {
          ...(since && { gte: new Date(since) }),
          ...(until && { lte: new Date(`${until}T23:59:59.999Z`) }),
        },
      }),
    },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  })

  return NextResponse.json({ count: items.length, items })
}

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
  const results: { url?: string; status: string; error?: string }[] = []

  for (const raw of items) {
    const it = raw as Record<string, string | string[] | undefined>
    const url = it.url as string | undefined
    const partner = it.partner as string | undefined
    const type = it.type as string | undefined
    const show = it.show as string | undefined
    const title = it.title as string | undefined

    if (!partner || !type || !show || !title || !url) {
      results.push({ url, status: "skipped", error: "partner, type, show, title and url are required" })
      continue
    }

    // Same URL guard the content ingest uses, so re-running a scan is safe.
    const dupe = await prisma.mediaAppearance.findFirst({ where: { url }, select: { id: true } })
    if (dupe) {
      results.push({ url, status: "duplicate" })
      continue
    }

    try {
      await prisma.mediaAppearance.create({
        data: {
          partner,
          type,
          show,
          title,
          url,
          publishedAt: it.publishedAt ? new Date(it.publishedAt as string) : null,
          topics: Array.isArray(it.topics) ? (it.topics as string[]) : [],
          notes: (it.notes as string) ?? null,
          status: "ready",
        },
      })
      results.push({ url, status: "added" })
    } catch (err) {
      results.push({ url, status: "error", error: err instanceof Error ? err.message : String(err) })
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
