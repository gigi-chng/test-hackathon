import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export const maxDuration = 120

/**
 * Remove duplicate rows from partner_content.
 *
 * sourceUrl is the identity of a piece of content — for transcripts it is
 * "transcript:<transcriptId>:<partner>:<chunkIndex>", so the same value
 * appearing twice always means the same chunk was written more than once. It
 * happened because confirming a transcript read its status and wrote it in
 * separate steps, so two simultaneous confirmations both extracted.
 *
 * Duplicates are not harmless: they rank twice in the /reactions similarity
 * search and they double-count when voice profiles are generated.
 *
 * Reports by default and only deletes with ?apply=1, because this is the one
 * admin route that destroys rows. Keeps the earliest of each group.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const apply = req.nextUrl.searchParams.get("apply") === "1"

  // Only rows with a sourceUrl can be compared this way. A null sourceUrl
  // carries no identity, so grouping those together would delete unrelated
  // content.
  const rows = await prisma.partnerContent.findMany({
    where: { sourceUrl: { not: null } },
    select: { id: true, sourceUrl: true, sourceType: true, partner: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = r.sourceUrl as string
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  const dupeGroups = [...groups.entries()].filter(([, v]) => v.length > 1)

  // Everything after the first in each group. Earliest wins.
  const doomed = dupeGroups.flatMap(([, v]) => v.slice(1))

  const byType: Record<string, number> = {}
  const byPartner: Record<string, number> = {}
  for (const r of doomed) {
    byType[r.sourceType] = (byType[r.sourceType] ?? 0) + 1
    byPartner[r.partner] = (byPartner[r.partner] ?? 0) + 1
  }

  const summary = {
    ok: true,
    applied: apply,
    scanned: rows.length,
    duplicateGroups: dupeGroups.length,
    rowsToRemove: doomed.length,
    byType,
    byPartner,
    largestGroups: dupeGroups
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([url, v]) => ({ sourceUrl: url, copies: v.length })),
  }

  if (!apply) {
    return NextResponse.json({
      ...summary,
      note: "Nothing deleted. Re-run with ?apply=1 to remove these.",
    })
  }

  let removed = 0
  // Chunked so a large cleanup can't build one enormous statement.
  for (let i = 0; i < doomed.length; i += 200) {
    const batch = doomed.slice(i, i + 200).map(r => r.id)
    const res = await prisma.partnerContent.deleteMany({ where: { id: { in: batch } } })
    removed += res.count
  }

  const remaining = await prisma.partnerContent.count()

  return NextResponse.json({ ...summary, removed, remaining })
}
