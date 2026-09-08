import { NextRequest, NextResponse } from "next/server"
import { listRiversideProjects, setSelectedProjects } from "@/lib/actions/riverside-sync"
import { prisma } from "@/lib/db/prisma"
import { detectSpeakers, resolveAliases } from "@/lib/actions/transcripts"

export const maxDuration = 60

/**
 * Read or set which Riverside scopes the sync pulls from, against whichever
 * database this is deployed on.
 *
 * The selection lives in app_settings rather than an env var, so production
 * can't be configured from a local script — .env points at dev. The picker on
 * /transcripts is the normal way in; this exists so production can be
 * bootstrapped (or audited) without exporting production credentials.
 *
 *   GET                      -> available scopes and what's currently selected
 *   GET ?select=auto         -> tick the Slow production, same rule as the UI
 *   GET ?select=a,b  -> tick exactly these scope ids
 *   GET ?select=none         -> tick nothing (the sync then does nothing)
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ?status=1 reports the review queue without changing anything, so the
  // state of production is checkable without exporting its credentials.
  if (req.nextUrl.searchParams.get("status") === "1") {
    const [pending, confirmed, aliases, passages] = await Promise.all([
      prisma.transcript.findMany({
        where: { status: "pending" },
        select: { id: true, title: true, rawText: true, identifyChoices: true },
      }),
      prisma.transcript.count({ where: { status: "confirmed", riversideId: { not: null } } }),
      prisma.speakerAlias.findMany({ select: { display: true, partner: true } }),
      prisma.partnerContent.count({ where: { sourceType: "transcript" } }),
    ])

    const stuck: { title: string; reason: string }[] = []
    let awaitingAnswers = 0

    for (const row of pending) {
      const detected = await detectSpeakers(row.rawText)
      const choices = (row.identifyChoices ?? {}) as Record<string, string>
      if (detected.unlabeled) {
        stuck.push({ title: row.title.slice(0, 70), reason: "no speaker labels" })
        continue
      }
      const { unknown } = await resolveAliases(detected.speakers.map(s => s.label))
      const undecided = unknown.filter(l => !(l in choices))
      if (undecided.length > 0) { awaitingAnswers += 1; continue }

      // Fully answered but still pending means something blocked the sort.
      const seen = new Map<string, string>()
      let clash: string | null = null
      for (const [label, pick] of Object.entries(choices)) {
        if (pick === "none") continue
        if (seen.has(pick)) clash = `${pick} claimed by "${seen.get(pick)}" and "${label}"`
        seen.set(pick, label)
      }
      stuck.push({ title: row.title.slice(0, 70), reason: clash ?? "answered, awaiting next sweep" })
    }

    return NextResponse.json({
      ok: true,
      pending: pending.length,
      awaitingAnswers,
      stuck,
      confirmed,
      passagesInLibrary: passages,
      aliases: aliases.map(a => `${a.display} = ${a.partner ?? "not a partner"}`),
    })
  }

  const res = await listRiversideProjects()
  if (!res.ok) {
    return NextResponse.json({ ok: false, reason: res.reason }, { status: 502 })
  }

  const select = req.nextUrl.searchParams.get("select")

  if (select) {
    const known = new Set(
      res.productions.flatMap(p => [p.id, ...p.scopes.map(s => s.id)])
    )
    const requested =
      select === "auto" ? res.suggested
      : select === "none" ? []
      : select.split(",").map(s => s.trim()).filter(Boolean)

    const unknown = requested.filter(id => !known.has(id))
    if (unknown.length > 0) {
      return NextResponse.json(
        { ok: false, error: "Unknown scope ids", unknown, known: [...known] },
        { status: 400 }
      )
    }

    await setSelectedProjects(requested)
    return NextResponse.json({ ok: true, selected: requested })
  }

  return NextResponse.json({
    ok: true,
    selected: res.selected,
    suggested: res.suggested,
    productions: res.productions.map(p => ({
      id: p.id,
      name: p.name,
      recordings: p.recordings,
      scopes: p.scopes.length,
    })),
  })
}
