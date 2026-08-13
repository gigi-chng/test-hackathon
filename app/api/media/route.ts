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
    const it = raw as Record<string, string | string[] | boolean | undefined>
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
          verified: it.verified === true || it.verified === "true",
          verifiedNote: (it.verifiedNote as string) ?? null,
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

// Flip verification on an existing row once a human has read the source.
export async function PATCH(req: NextRequest) {
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
  const results: { url?: string; status: string }[] = []

  for (const raw of items) {
    const it = raw as { url?: string; newUrl?: string; verified?: boolean; verifiedNote?: string; delete?: boolean }
    if (!it.url) { results.push({ status: "skipped" }); continue }

    const row = await prisma.mediaAppearance.findFirst({ where: { url: it.url }, select: { id: true } })
    if (!row) { results.push({ url: it.url, status: "not found" }); continue }

    if (it.delete) {
      await prisma.mediaAppearance.delete({ where: { id: row.id } })
      results.push({ url: it.url, status: "deleted" })
      continue
    }

    await prisma.mediaAppearance.update({
      where: { id: row.id },
      data: {
        ...(it.newUrl && { url: it.newUrl }),
        ...(it.verified !== undefined && { verified: it.verified }),
        ...(it.verifiedNote !== undefined && { verifiedNote: it.verifiedNote }),
      },
    })
    results.push({ url: it.url, status: "updated" })
  }

  return NextResponse.json({ ok: true, results })
}
