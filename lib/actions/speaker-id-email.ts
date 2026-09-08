"use server"

import { randomUUID } from "crypto"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { detectSpeakers, resolveAliases } from "@/lib/actions/transcripts"
import { isGenericLabel } from "@/lib/transcript-parse"
import { PARTNERS, type Partner } from "@/lib/partners"

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://slow-hackathon-xi.vercel.app"

const LAST_SENT_KEY = "RIVERSIDE_DIGEST_SENT_AT"

// One a day. Checked at 20h rather than 24h so a cron that fires slightly
// earlier than the previous day's run doesn't silently skip a day.
const MIN_GAP_HOURS = 20

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const CHOICES: [string, string][] = [
  ...(Object.keys(PARTNERS) as Partner[]).map(
    k => [k, PARTNERS[k].displayName.split(" ")[0]] as [string, string]
  ),
  ["none", "Not a partner"],
]

function buttons(token: string, label: string) {
  return CHOICES.map(
    ([key, text]) =>
      `<a href="${BASE}/api/riverside/identify?token=${token}&amp;s=${encodeURIComponent(label)}&amp;p=${key}"
style="display:inline-block;margin:0 5px 5px 0;padding:6px 12px;border:1px solid #ccc;
border-radius:6px;color:#111;text-decoration:none;font-size:13px">${esc(text)}</a>`
  ).join("")
}

/**
 * One running list of every speaker still to be identified.
 *
 * Named speakers are grouped: a real name is the same person everywhere, so
 * answering once settles every recording they appear in and the list shrinks
 * by more than one row. Positional labels can't be grouped — "Speaker 1" is a
 * different person in each recording — so those are listed per recording with
 * their isolated audio.
 *
 * Anything never identified simply never reaches the library, which is the
 * intended default rather than a backlog to clear.
 */
export async function sendOutstandingSpeakers(opts: { force?: boolean } = {}): Promise<{
  named: number
  unnamedRecordings: number
  recordings: number
  sent: boolean
  skipped?: string
}> {
  const to = process.env.REPORT_EMAIL
  const empty = { named: 0, unnamedRecordings: 0, recordings: 0, sent: false }
  if (!to || !process.env.RESEND_API_KEY) return empty

  // Rate limited on the send, not on the cron schedule, so a manual run or a
  // retried invocation can't turn one day's list into several emails.
  const lastSent = await prisma.appSetting.findUnique({ where: { key: LAST_SENT_KEY } })
  if (!opts.force && lastSent?.value) {
    const hours = (Date.now() - new Date(lastSent.value).getTime()) / 3_600_000
    if (hours < MIN_GAP_HOURS) {
      return { ...empty, skipped: `already sent ${hours.toFixed(1)}h ago` }
    }
  }

  const rows = await prisma.transcript.findMany({
    where: { status: "pending" },
    orderBy: [{ recordedAt: { sort: "desc", nulls: "last" } }],
  })
  if (rows.length === 0) return empty

  // label -> where it appears, for names that can be settled globally
  const byName = new Map<
    string,
    { words: number; sample: string; token: string; titles: string[] }
  >()
  // per-recording blocks for positional labels
  const anonBlocks: string[] = []
  let touched = 0

  for (const row of rows) {
    let token = row.identifyToken
    if (!token) {
      token = randomUUID()
      await prisma.transcript.update({ where: { id: row.id }, data: { identifyToken: token } })
    }

    const detected = await detectSpeakers(row.rawText)
    const choices = (row.identifyChoices ?? {}) as Record<string, string>
    const { unknown } = await resolveAliases(detected.speakers.map(s => s.label))
    const undecided = detected.speakers.filter(
      s => unknown.includes(s.label) && !(s.label in choices)
    )
    if (undecided.length === 0) continue
    touched += 1

    const media = (row.speakerMedia ?? {}) as Record<string, string>
    const when = row.recordedAt
      ? row.recordedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "no date"

    const anon = undecided.filter(s => isGenericLabel(s.label))
    for (const s of undecided) {
      if (isGenericLabel(s.label)) continue
      const entry = byName.get(s.label) ?? {
        words: 0, sample: s.sample, token, titles: [],
      }
      entry.words += s.words
      entry.titles.push(row.title)
      // Any one recording's token settles the name everywhere, so whichever
      // was seen first is fine — no need to pick a "best" one.
      byName.set(s.label, entry)
    }

    if (anon.length > 0) {
      anonBlocks.push(`<div style="margin:0 0 22px;padding-left:12px;border-left:3px solid #eee">
<p style="margin:0 0 2px"><strong>${esc(row.title.slice(0, 90))}</strong></p>
<p style="margin:0 0 10px;color:#777;font-size:12px">${when}${
        row.sourceProject ? ` · ${esc(row.sourceProject)}` : ""
      }</p>
${anon
  .map(
    s => `<p style="margin:0 0 3px">
<strong>${esc(s.label)}</strong>
<span style="color:#777"> · ${s.words.toLocaleString()} words${
      media[s.label]
        ? ` · <a href="${BASE}/api/riverside/audio?t=${row.id}&amp;s=${encodeURIComponent(
            s.label
          )}" style="color:#0645ad">listen</a>`
        : ""
    }</span></p>
<p style="margin:0 0 6px;color:#555;font-style:italic;font-size:13px">&ldquo;${esc(
      s.sample.slice(0, 150)
    )}&hellip;&rdquo;</p>
${buttons(token, s.label)}`
  )
  .join("")}
<p style="margin:8px 0 0">
<a href="${BASE}/api/riverside/identify?token=${token}&amp;finalize=1"
style="color:#777;font-size:12px">skip this recording &rarr;</a></p>
</div>`)
    }
  }

  if (byName.size === 0 && anonBlocks.length === 0) return empty

  const nameRows = [...byName.entries()]
    .sort((a, b) => b[1].words - a[1].words)
    .map(
      ([label, v]) => `<div style="margin:0 0 18px">
<p style="margin:0 0 2px"><strong>${esc(label)}</strong>
<span style="color:#777"> · ${v.words.toLocaleString()} words across ${v.titles.length} recording${
        v.titles.length === 1 ? "" : "s"
      }</span></p>
<p style="margin:0 0 6px;color:#555;font-style:italic;font-size:13px">&ldquo;${esc(
        v.sample.slice(0, 150)
      )}&hellip;&rdquo;</p>
${buttons(v.token, label)}
</div>`
    )
    .join("")

  const subject = `${byName.size + anonBlocks.length} speakers to identify across ${touched} recording${
    touched === 1 ? "" : "s"
  }`

  await new Resend(process.env.RESEND_API_KEY)
    .emails.send({
      from: "Content Library <onboarding@resend.dev>",
      to,
      subject,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;max-width:680px">
<p><strong>${touched} recording${touched === 1 ? "" : "s"}</strong> are waiting on speaker
identification. Nothing is saved to anyone's library until you say who is who, and anything
you never identify simply doesn't get saved &mdash; there's no need to clear this list.</p>

${
  byName.size > 0
    ? `<h3 style="margin:26px 0 4px;font-size:15px">Names (${byName.size})</h3>
<p style="margin:0 0 16px;color:#777;font-size:13px">Answering one of these settles that person
in every recording they appear in.</p>
${nameRows}`
    : ""
}

${
  anonBlocks.length > 0
    ? `<h3 style="margin:26px 0 4px;font-size:15px">Unnamed voices (${anonBlocks.length} recording${
        anonBlocks.length === 1 ? "" : "s"
      })</h3>
<p style="margin:0 0 16px;color:#777;font-size:13px">Riverside labelled these by position, so
&ldquo;Speaker 1&rdquo; is a different person in each one and they can't be answered in bulk.
Listen to a voice to place it. These answers are never remembered.</p>
${anonBlocks.join("")}`
    : ""
}

<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:13px"><a href="${BASE}/transcripts" style="color:#0645ad">Do it all in the app &rarr;</a></p>
</div>`,
    })
    .catch(err => {
      console.error("[outstanding-speakers]", err)
      throw err
    })

  await prisma.transcript.updateMany({
    where: { status: "pending", speakerAlertAt: null },
    data: { speakerAlertAt: new Date() },
  })

  await prisma.appSetting.upsert({
    where: { key: LAST_SENT_KEY },
    create: { key: LAST_SENT_KEY, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  return { named: byName.size, unnamedRecordings: anonBlocks.length, recordings: touched, sent: true }
}
