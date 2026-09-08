"use server"

import { randomUUID } from "crypto"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { detectSpeakers, resolveAliases } from "@/lib/actions/transcripts"
import { isGenericLabel } from "@/lib/transcript-parse"
import { PARTNERS, type Partner } from "@/lib/partners"

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://slow-hackathon-xi.vercel.app"

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Ask who the unnamed speakers are, before anything gets sorted into a
 * partner's library.
 *
 * Uploaded recordings get diarized without names — "speaker-0", "Speaker 2" —
 * and there is no way to tell from text alone whether Speaker 1 is Sam or a
 * guest. Each of those voices does have its own audio track though, so the
 * email links to that one speaker in isolation alongside their longest quote.
 *
 * Sends once per recording. The transcript sits in the review queue, unsorted,
 * until someone maps it.
 */
export async function sendSpeakerIdRequests(): Promise<{ sent: number; recordings: string[] }> {
  const to = process.env.REPORT_EMAIL
  if (!to || !process.env.RESEND_API_KEY) return { sent: 0, recordings: [] }

  const rows = await prisma.transcript.findMany({
    where: { status: "pending", speakerAlertAt: null, riversideId: { not: null } },
    orderBy: { recordedAt: "desc" },
  })

  const blocks: string[] = []
  const alerted: string[] = []

  for (const row of rows) {
    const detected = await detectSpeakers(row.rawText)
    const unnamed = detected.speakers.filter(s => isGenericLabel(s.label))

    // Nothing anonymous here — the normal review queue covers it.
    if (unnamed.length === 0 && !detected.unlabeled) continue

    // Buttons go on every speaker still awaiting a decision, not just the
    // anonymous ones: a recording can only be sorted once all of them are
    // answered, so a named guest sitting unresolved would strand it.
    const { unknown } = await resolveAliases(detected.speakers.map(s => s.label))
    const undecided = new Set(unknown)

    // @default(cuid()) is applied by Prisma on create, so a row that predates
    // this column has none. Mint one rather than emailing a dead link.
    let token = row.identifyToken
    if (!token) {
      token = randomUUID()
      await prisma.transcript.update({ where: { id: row.id }, data: { identifyToken: token } })
    }

    const media = (row.speakerMedia ?? {}) as Record<string, string>
    const when = row.recordedAt
      ? row.recordedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "no date"

    // One tap per choice. These are GETs that only render a confirm page; the
    // actual write needs the button on that page, so a link scanner can't map
    // a speaker by accident.
    const buttons = (label: string) => {
      const opts: [string, string][] = [
        ...(Object.keys(PARTNERS) as Partner[]).map(
          k => [k, PARTNERS[k].displayName.split(" ")[0]] as [string, string]
        ),
        ["none", "Not a partner"],
      ]
      return opts
        .map(
          ([key, text]) =>
            `<a href="${BASE}/api/riverside/identify?token=${token}&amp;s=${encodeURIComponent(
              label
            )}&amp;p=${key}" style="display:inline-block;margin:0 6px 6px 0;padding:7px 13px;
border:1px solid #ccc;border-radius:6px;color:#111;text-decoration:none;font-size:13px">${esc(text)}</a>`
        )
        .join("")
    }

    const speakerRows = detected.unlabeled
      ? `<p style="margin:8px 0;color:#b00">Riverside produced no speaker labels at all for this
recording, so it can't be split by voice. It needs the per-participant tracks exporting by hand.</p>`
      : detected.speakers
          .filter(s => undecided.has(s.label))
          .map(s => {
            const listen = media[s.label]
              ? ` &middot; <a href="${BASE}/api/riverside/audio?t=${row.id}&amp;s=${encodeURIComponent(s.label)}"
style="color:#0645ad">listen</a>`
              : ""
            return `<div style="margin:0 0 18px">
<p style="margin:0 0 2px">
<strong>${esc(s.label)}</strong>
<span style="color:#666"> &middot; ${s.words.toLocaleString()} words${listen}</span>
${isGenericLabel(s.label) ? ` <span style="color:#b8860b;font-size:12px">unnamed</span>` : ""}
</p>
<p style="margin:0 0 8px;color:#555;font-style:italic">&ldquo;${esc(s.sample)}&hellip;&rdquo;</p>
${buttons(s.label)}
</div>`
          })
          .join("")

    blocks.push(`<div style="margin:0 0 28px">
<p style="margin:0 0 2px"><strong>${esc(row.title)}</strong></p>
<p style="margin:0 0 10px;color:#666;font-size:13px">
${when}${row.sourceProject ? ` · ${esc(row.sourceProject)}` : ""} ·
${detected.speakers.length} speaker${detected.speakers.length === 1 ? "" : "s"},
${unnamed.length} unnamed
</p>
${speakerRows}
<p style="margin:10px 0 0;font-size:13px">
<a href="${BASE}/transcripts" style="color:#0645ad">Or map them all in the app &rarr;</a>
</p>
</div>`)

    alerted.push(row.id)
  }

  if (blocks.length === 0) return { sent: 0, recordings: [] }

  const subject =
    blocks.length === 1
      ? "1 recording has unnamed speakers — who is who?"
      : `${blocks.length} recordings have unnamed speakers — who is who?`

  await new Resend(process.env.RESEND_API_KEY)
    .emails.send({
      from: "Content Library <onboarding@resend.dev>",
      to,
      subject,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;max-width:680px">
<p>Riverside diarized these without names, so nothing has been sorted into anyone's
library yet. Listen to a voice, then tap who it is — one tap per speaker. Nothing is
sorted until every speaker in a recording has been answered.</p>
<p style="color:#666;font-size:13px">Once you've named someone whose label is a real
name, that decision is remembered. Positional labels like &ldquo;Speaker 1&rdquo; never are —
they mean a different person in every recording.</p>
<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
${blocks.join("")}
</div>`,
    })
    .catch(err => {
      console.error("[speaker-id-email]", err)
      throw err
    })

  await prisma.transcript.updateMany({
    where: { id: { in: alerted } },
    data: { speakerAlertAt: new Date() },
  })

  return { sent: blocks.length, recordings: alerted }
}
