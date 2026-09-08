import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import {
  syncRiverside,
  resolvePendingTranscripts,
  type SyncResult,
} from "@/lib/actions/riverside-sync"
import { sendOutstandingSpeakers } from "@/lib/actions/speaker-id-email"

export const maxDuration = 300

/**
 * Email the outcome. This job shares an API key with someone else's
 * integration, so the two things that must never pass silently are a rotated
 * key (everything 401s forever) and recordings piling up unreviewed.
 */
async function report(result: SyncResult, sinceDays: number, limitNote: number) {
  const to = process.env.REPORT_EMAIL
  if (!to || !process.env.RESEND_API_KEY) return

  const subject = result.authFailed
    ? "Riverside sync FAILED — API key rejected"
    : result.noProjectsSelected
      ? "Riverside sync — no productions selected"
      : result.queued > 0
      ? `Riverside sync — ${result.queued} recording${result.queued > 1 ? "s" : ""} need speaker mapping`
      : `Riverside sync — ${result.autoConfirmed} added`

  const body = result.authFailed
    ? `<p style="color:#b00"><strong>Riverside rejected the API key.</strong></p>
<p>The workspace has one shared key. If someone regenerated it in
Settings &rarr; Developers, this sync is dead until <code>RIVERSIDE_API_KEY</code>
is updated in Vercel. Nothing has been imported since this started failing.</p>`
    : result.noProjectsSelected
      ? `<p>Nothing was pulled — no productions are ticked on
<a href="https://slow-hackathon-xi.vercel.app/transcripts">/transcripts</a>.
The sync only ever imports the productions picked there, so it stays idle until
one is selected.</p>`
      : `<p>Checked the last ${sinceDays} days.</p>
<ul style="font-family:system-ui,sans-serif;font-size:14px">
<li>${result.checked} recordings seen</li>
<li>${result.autoConfirmed} extracted automatically (every speaker already known)</li>
<li>${result.queued} waiting for speaker mapping</li>
<li>${result.notReady} still transcribing on Riverside's side</li>
<li>${result.skipped} already imported</li>
${result.deferred > 0 ? `<li>${result.deferred} left for the next run (hit the ${limitNote} cap)</li>` : ""}
</ul>
${
  result.queued > 0
    ? `<p><a href="https://slow-hackathon-xi.vercel.app/transcripts">Review them</a> —
each new name only needs confirming once, then it's remembered.</p>`
    : ""
}`

  const errors = result.errors.length
    ? `<p style="color:#b00"><strong>Errors:</strong></p><ul>${result.errors
        .map(e => `<li style="color:#b00">${e}</li>`)
        .join("")}</ul>`
    : ""

  await new Resend(process.env.RESEND_API_KEY)
    .emails.send({
      from: "Content Library <onboarding@resend.dev>",
      to,
      subject,
      html: body + errors,
    })
    .catch(() => {})
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Widen the window for a one-off backfill: ?days=365&limit=100
  const sinceDays = Math.min(
    parseInt(req.nextUrl.searchParams.get("days") ?? "30"),
    365
  )
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "20"), 100)

  let result: SyncResult
  try {
    result = await syncRiverside({ sinceDays, limit })
  } catch (err) {
    console.error("[sync-riverside]", err)
    result = {
      checked: 0, autoConfirmed: 0, queued: 0, skipped: 0, deferred: 0, notReady: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    }
  }

  // Recordings already in the queue may have become resolvable since the last
  // run, as names get confirmed. Sweep those before asking about anything new.
  let retroSorted = 0
  let unlabeledSkipped = 0
  try {
    const swept = await resolvePendingTranscripts()
    retroSorted = swept.resolved
    unlabeledSkipped = swept.unlabeledSkipped
    result.errors.push(...swept.errors)
  } catch (err) {
    console.error("[sync-riverside] pending sweep failed", err)
  }

  // One running list of everything still unidentified, rather than an email
  // per recording — a backfill of 47 would otherwise mean a burst of them.
  let outstanding: Awaited<ReturnType<typeof sendOutstandingSpeakers>> | null = null
  try {
    // ?digest=force re-sends within the daily window, for when the list is
    // wanted on demand rather than waiting for tomorrow.
    outstanding = await sendOutstandingSpeakers({
      force: req.nextUrl.searchParams.get("digest") === "force",
    })
  } catch (err) {
    console.error("[sync-riverside] speaker-id email failed", err)
    result.errors.push(
      `outstanding-speakers email failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  await report(result, sinceDays, limit)

  return NextResponse.json({ ok: !result.authFailed, ...result, retroSorted, unlabeledSkipped, outstanding })
}
