"use server"

import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS } from "@/lib/partners"
import type { BlogIngestResult } from "@/lib/actions/ingest"

const getResend = () => new Resend(process.env.RESEND_API_KEY)

type Row = BlogIngestResult & { error?: string }

export async function sendIngestReport(
  results: Record<string, Row>,
  repair = false,
): Promise<void> {
  const to = process.env.REPORT_EMAIL
  if (!to || !process.env.RESEND_API_KEY) return

  // Library totals give the "is this partner actually covered" answer that
  // per-run counts can't — a run of all zeroes looks identical whether the
  // archive is complete or the scraper has never worked.
  const totals = await prisma.partnerContent.groupBy({
    by: ["partner"],
    where: { sourceType: { in: ["newsletter", "blog"] } },
    _count: { id: true },
  })
  const totalMap = Object.fromEntries(totals.map(t => [t.partner, t._count.id]))

  const rows = Object.entries(results)
    .map(([partner, r]) => {
      const held = totalMap[partner] ?? 0
      const status = r.error
        ? `<span style="color:#b00">${r.error}</span>`
        : r.message
          ? `<span style="color:#b00">${r.message}</span>`
          : held === 0
            ? `<span style="color:#b00">nothing stored — scraper is not working</span>`
            : "ok"
      return `<tr>
<td style="padding:4px 10px 4px 0"><strong>${partner}</strong></td>
<td style="padding:4px 10px 4px 0">+${r.ingested}</td>
${repair ? `<td style="padding:4px 10px 4px 0">${r.repaired ?? 0}</td>` : ""}
<td style="padding:4px 10px 4px 0">${held} total</td>
<td style="padding:4px 10px 4px 0">${status}</td>
</tr>`
    })
    .join("")

  const added = Object.values(results).reduce((n, r) => n + r.ingested, 0)
  const fixed = Object.values(results).reduce((n, r) => n + (r.repaired ?? 0), 0)
  const broken = Object.entries(results).filter(
    ([p, r]) => r.error || r.message || (totalMap[p] ?? 0) === 0,
  )

  const subject = repair
    ? `Blog repair — ${fixed} posts corrected`
    : broken.length
      ? `Blog ingest — ${added} added, ${broken.length} partner${broken.length > 1 ? "s" : ""} need attention`
      : `Blog ingest — ${added} added`

  await getResend()
    .emails.send({
      from: "Content Library <onboarding@resend.dev>",
      to,
      subject,
      html: `<p>${repair ? "Repair pass over stored posts." : "Weekly blog and newsletter ingest."}</p>
<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">
<tr style="text-align:left;border-bottom:1px solid #ddd">
<th style="padding:4px 10px 4px 0">Partner</th>
<th style="padding:4px 10px 4px 0">Added</th>
${repair ? `<th style="padding:4px 10px 4px 0">Fixed</th>` : ""}
<th style="padding:4px 10px 4px 0">Library</th>
<th style="padding:4px 10px 4px 0">Status</th></tr>
${rows}
</table>
${
  broken.length
    ? `<p style="color:#b00"><strong>Needs attention:</strong> ${broken
        .map(([p]) => PARTNERS[p as keyof typeof PARTNERS]?.displayName ?? p)
        .join(", ")}</p>`
    : ""
}`,
    })
    .catch(() => {})
}
