import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS } from "@/lib/partners"

export const maxDuration = 60

const getResend = () => new Resend(process.env.RESEND_API_KEY)

const name = (p: string) =>
  PARTNERS[p as keyof typeof PARTNERS]?.displayName ?? p

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const unverified = await prisma.mediaAppearance.findMany({
    where: { verified: false },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }],
  })
  const verifiedCount = await prisma.mediaAppearance.count({ where: { verified: true } })

  const to = process.env.REPORT_EMAIL
  if (to && process.env.RESEND_API_KEY) {
    const rows = unverified
      .map(
        m => `<tr>
<td style="padding:6px 10px 6px 0;vertical-align:top"><strong>${name(m.partner)}</strong></td>
<td style="padding:6px 10px 6px 0;vertical-align:top">${(m.publishedAt?.toISOString().slice(0, 10)) ?? "—"}</td>
<td style="padding:6px 10px 6px 0;vertical-align:top">${m.show}</td>
<td style="padding:6px 10px 6px 0;vertical-align:top">
  <a href="${m.url}">${m.title}</a>
  ${m.verifiedNote ? `<div style="color:#b00;font-size:12px;margin-top:3px">${m.verifiedNote}</div>` : ""}
</td>
</tr>`
      )
      .join("")

    const html = unverified.length
      ? `<p>These media appearances are in the tracker but <strong>nobody has confirmed the partner or Slow Ventures is actually named in the source</strong>. Each one is either paywalled, blocks automated reading, or was found only via a search summary.</p>
<p>Open each link, confirm we're mentioned, and reply with the ones that check out. Anything that doesn't should be deleted.</p>
<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">
<tr style="text-align:left;border-bottom:1px solid #ddd">
<th style="padding:6px 10px 6px 0">Partner</th><th style="padding:6px 10px 6px 0">Date</th>
<th style="padding:6px 10px 6px 0">Outlet</th><th style="padding:6px 10px 6px 0">Piece</th></tr>
${rows}
</table>
<p style="color:#666;font-size:13px">${verifiedCount} appearance${verifiedCount === 1 ? "" : "s"} already confirmed and not listed here.</p>`
      : `<p>Nothing needs manual verification. All ${verifiedCount} media appearances in the tracker have a confirmed mention.</p>`

    await getResend()
      .emails.send({
        from: "Media Tracker <onboarding@resend.dev>",
        to,
        subject: unverified.length
          ? `Media verification — ${unverified.length} to confirm`
          : "Media verification — all clear",
        html,
      })
      .catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    unverified: unverified.length,
    verified: verifiedCount,
    items: unverified.map(m => ({ partner: m.partner, show: m.show, url: m.url })),
  })
}
