import { NextRequest, NextResponse } from "next/server"
import { listRiversideProjects, setSelectedProjects } from "@/lib/actions/riverside-sync"

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
