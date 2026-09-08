import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"
import { PARTNERS, type Partner } from "@/lib/partners"
import {
  detectSpeakers,
  resolveAliases,
  confirmTranscript,
  rememberAlias,
} from "@/lib/actions/transcripts"
import { isGenericLabel } from "@/lib/transcript-parse"

export const maxDuration = 300

/**
 * One-click speaker identification from the "who is this?" email.
 *
 * The token is the credential, same as the media verification links. Two
 * phases on purpose: GET only ever *shows* the choice, and applying it needs
 * the POST that the confirm button submits. Email security scanners follow
 * links, and a fetched GET that silently wrote a mapping would put one
 * person's words in another's library without anyone clicking.
 */

function page(title: string, body: string, tone: "ok" | "warn" = "ok") {
  const color = tone === "warn" ? "#b00" : "#111"
  return new NextResponse(
    `<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"></head>
<body style="font-family:system-ui,sans-serif;padding:32px;max-width:560px;line-height:1.5">
  <h2 style="margin:0 0 12px;color:${color}">${title}</h2>
  ${body}
  <p style="color:#999;font-size:13px;margin-top:28px">Slow Ventures content library</p>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  )
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function partnerName(key: string): string {
  return key === "none" ? "not a partner" : (PARTNERS[key as Partner]?.displayName ?? key)
}

async function load(token: string) {
  return prisma.transcript.findUnique({ where: { identifyToken: token } })
}

/** Which labels still have no decision, from aliases or from earlier taps. */
async function outstanding(rawText: string, choices: Record<string, string>) {
  const detected = await detectSpeakers(rawText)
  const labels = detected.speakers.map(s => s.label)
  const { speakerMap: remembered, unknown } = await resolveAliases(labels)
  return {
    detected,
    remembered,
    undecided: unknown.filter(l => !(l in choices)),
  }
}

/**
 * "Sort it with what I've told you." Anyone still unidentified is treated as
 * not a partner, so their words simply don't enter the library. Requiring
 * every speaker to be named meant one unrecognised guest could hold a whole
 * recording out of the library indefinitely.
 */
async function confirmFinalize(token: string | null) {
  if (!token) return page("Invalid link", "<p>Missing token.</p>", "warn")
  const row = await load(token)
  if (!row) return page("Not found", "<p>That recording no longer exists.</p>", "warn")
  if (row.status === "confirmed") {
    return page("Already sorted", `<p><strong>${esc(row.title)}</strong> is already done.</p>`)
  }

  const choices = (row.identifyChoices ?? {}) as Record<string, string>
  const { detected, undecided } = await outstanding(row.rawText, choices)
  const named = Object.entries(choices).filter(([, p]) => p !== "none")

  return page(
    "Sort it now?",
    `<p><strong>${esc(row.title)}</strong></p>
     <p>${
       named.length
         ? `Will be saved: ${named.map(([l, p]) => `<strong>${esc(partnerName(p))}</strong> (${esc(l)})`).join(", ")}.`
         : "Nothing has been identified as a partner, so <strong>nothing will be saved</strong>."
     }</p>
     ${
       undecided.length
         ? `<p style="color:#666">Not identified, so dropped:
            ${undecided.map(esc).join(", ")}.</p>`
         : ""
       }
     <form method="POST" action="/api/riverside/identify">
       <input type="hidden" name="token" value="${esc(token)}">
       <input type="hidden" name="finalize" value="1">
       <button type="submit" style="background:#111;color:#fff;border:0;border-radius:6px;
         padding:11px 20px;font-size:15px;cursor:pointer">${
           named.length ? "Sort it" : "Skip this recording"
         }</button>
     </form>
     <p style="color:#999;font-size:13px;margin-top:16px">${detected.speakers.length} speakers detected.
     You can still delete and re-import it from /transcripts afterwards.</p>`
  )
}

// ─── GET: show the confirmation ──────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  const speaker = req.nextUrl.searchParams.get("s")
  const choice = req.nextUrl.searchParams.get("p")
  const finalize = req.nextUrl.searchParams.get("finalize") === "1"

  if (finalize) return confirmFinalize(token)

  if (!token || !speaker || !choice) {
    return page("Invalid link", "<p>That link is missing information.</p>", "warn")
  }
  if (choice !== "none" && !(choice in PARTNERS)) {
    return page("Invalid link", `<p>&ldquo;${esc(choice)}&rdquo; isn't a partner.</p>`, "warn")
  }

  const row = await load(token)
  if (!row) return page("Not found", "<p>That recording no longer exists.</p>", "warn")

  if (row.status === "confirmed") {
    return page(
      "Already sorted",
      `<p><strong>${esc(row.title)}</strong></p>
       <p>This recording has already been sorted. To change the mapping, delete it on
       <a href="/transcripts">/transcripts</a> and re-import it.</p>`
    )
  }

  const choices = (row.identifyChoices ?? {}) as Record<string, string>

  if (choices[speaker]) {
    return page(
      "Already answered",
      `<p><strong>${esc(speaker)}</strong> in ${esc(row.title)} is already set to
       <strong>${esc(partnerName(choices[speaker]))}</strong>.</p>
       <p>Change it on <a href="/transcripts">/transcripts</a>.</p>`
    )
  }

  // Two labels can't be the same partner — speakerMap is keyed by partner.
  const clash = Object.entries(choices).find(([, p]) => p === choice && choice !== "none")
  if (clash) {
    return page(
      "That partner is already taken",
      `<p><strong>${esc(partnerName(choice))}</strong> is already mapped to
       <strong>${esc(clash[0])}</strong> in this recording.</p>
       <p>If that was wrong, sort it out on <a href="/transcripts">/transcripts</a>.</p>`,
      "warn"
    )
  }

  const { detected, undecided } = await outstanding(row.rawText, choices)
  const stats = detected.speakers.find(s => s.label === speaker)
  const remaining = undecided.filter(l => l !== speaker)

  return page(
    "Confirm",
    `<p style="font-size:16px">Mark <strong>${esc(speaker)}</strong> as
     <strong>${esc(partnerName(choice))}</strong>?</p>
     <p style="color:#666;font-size:13px">${esc(row.title)}${
       stats ? ` · ${stats.words.toLocaleString()} words` : ""
     }</p>
     ${
       stats
         ? `<p style="color:#555;font-style:italic;border-left:3px solid #ddd;padding-left:12px">
            &ldquo;${esc(stats.sample)}&hellip;&rdquo;</p>`
         : ""
     }
     <form method="POST" action="/api/riverside/identify">
       <input type="hidden" name="token" value="${esc(token)}">
       <input type="hidden" name="s" value="${esc(speaker)}">
       <input type="hidden" name="p" value="${esc(choice)}">
       <button type="submit" style="background:#111;color:#fff;border:0;border-radius:6px;
         padding:11px 20px;font-size:15px;cursor:pointer">Yes, that's ${esc(partnerName(choice))}</button>
     </form>
     <p style="color:#666;font-size:13px;margin-top:18px">${
       remaining.length
         ? `${remaining.length} other speaker${remaining.length === 1 ? "" : "s"} still to identify
            (${remaining.map(esc).join(", ")}). Nothing is sorted until they're all answered.`
         : "This is the last one — confirming will sort the recording into the libraries."
     }</p>`
  )
}

// ─── POST: apply it ──────────────────────────────────────────────────────────

/** Build partner -> label from remembered aliases plus tapped answers. */
function buildMap(
  remembered: Record<string, string>,
  choices: Record<string, string>
): { map: Record<string, string> } | { clash: [string, string, string] } {
  const map: Record<string, string> = { ...remembered }
  for (const [label, picked] of Object.entries(choices)) {
    if (picked === "none") continue
    if (map[picked] && map[picked] !== label) return { clash: [picked, map[picked], label] }
    map[picked] = label
  }
  return { map }
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const token = String(form.get("token") ?? "")
  const speaker = String(form.get("s") ?? "")
  const choice = String(form.get("p") ?? "")

  // "Sort it with what I've told you" — undecided speakers are dropped.
  if (String(form.get("finalize") ?? "") === "1") {
    const row = await load(token)
    if (!row) return page("Not found", "<p>That recording no longer exists.</p>", "warn")
    if (row.status === "confirmed") {
      return page("Already sorted", `<p><strong>${esc(row.title)}</strong> is already done.</p>`)
    }
    const choices = (row.identifyChoices ?? {}) as Record<string, string>
    const { remembered } = await outstanding(row.rawText, choices)
    const built = buildMap(remembered, choices)
    if ("clash" in built) {
      const [pk, a, b] = built.clash
      return page(
        "Conflicting answers",
        `<p><strong>${esc(partnerName(pk))}</strong> is mapped to both <strong>${esc(a)}</strong>
         and <strong>${esc(b)}</strong>. Sort it out on <a href="/transcripts">/transcripts</a>.</p>`,
        "warn"
      )
    }
    const result = await confirmTranscript(row.id, built.map)
    const added = Object.entries(result.stored)
    return page(
      added.length ? "Sorted" : "Skipped",
      `<p><strong>${esc(row.title)}</strong></p>
       ${
         added.length
           ? `<ul>${added
               .map(([pk, n]) => `<li>${esc(partnerName(pk))}: ${n} passage${n === 1 ? "" : "s"}</li>`)
               .join("")}</ul>`
           : "<p>Nothing was identified as a partner, so nothing was saved to the library.</p>"
       }
       <p><a href="/transcripts">/transcripts</a></p>`
    )
  }

  if (!token || !speaker || !choice) {
    return page("Invalid request", "<p>Missing information.</p>", "warn")
  }
  if (choice !== "none" && !(choice in PARTNERS)) {
    return page("Invalid request", `<p>&ldquo;${esc(choice)}&rdquo; isn't a partner.</p>`, "warn")
  }

  const row = await load(token)
  if (!row) return page("Not found", "<p>That recording no longer exists.</p>", "warn")
  if (row.status === "confirmed") {
    return page("Already sorted", `<p><strong>${esc(row.title)}</strong> is already done.</p>`)
  }

  const choices = { ...((row.identifyChoices ?? {}) as Record<string, string>) }
  if (!choices[speaker]) choices[speaker] = choice

  await prisma.transcript.update({
    where: { id: row.id },
    data: { identifyChoices: choices },
  })

  // Settle a real name globally the moment it's answered, so the same person
  // stops being asked about in every other recording they appear in. Refused
  // for positional labels, which mean a different person each time.
  await rememberAlias(speaker, choice === "none" ? null : choice)

  const { remembered, undecided } = await outstanding(row.rawText, choices)

  if (undecided.length > 0) {
    return page(
      "Got it",
      `<p><strong>${esc(speaker)}</strong> = ${esc(partnerName(choice))}${
        isGenericLabel(speaker) ? "" : ", remembered everywhere"
      }.</p>
       <p>Still unidentified in this recording: <strong>${undecided.map(esc).join(", ")}</strong>.</p>
       <p>Answer them from the email, or sort it now and drop them:</p>
       <form method="POST" action="/api/riverside/identify">
         <input type="hidden" name="token" value="${esc(token)}">
         <input type="hidden" name="finalize" value="1">
         <button type="submit" style="background:#111;color:#fff;border:0;border-radius:6px;
           padding:10px 18px;font-size:14px;cursor:pointer">Sort it now, the rest aren't partners</button>
       </form>`
    )
  }

  // Everyone is accounted for. Build partner -> label and extract.
  const speakerMap: Record<string, string> = { ...remembered }
  for (const [label, picked] of Object.entries(choices)) {
    if (picked === "none") continue
    if (speakerMap[picked] && speakerMap[picked] !== label) {
      return page(
        "Conflicting answers",
        `<p><strong>${esc(partnerName(picked))}</strong> ended up mapped to both
         <strong>${esc(speakerMap[picked])}</strong> and <strong>${esc(label)}</strong>.</p>
         <p>Sort it out on <a href="/transcripts">/transcripts</a>.</p>`,
        "warn"
      )
    }
    speakerMap[picked] = label
  }

  try {
    const result = await confirmTranscript(row.id, speakerMap)
    const added = Object.entries(result.stored)
    return page(
      "Sorted",
      `<p><strong>${esc(speaker)}</strong> = ${esc(partnerName(choice))} — that was the last one.</p>
       <p><strong>${esc(row.title)}</strong> has been added to the libraries:</p>
       <ul>${
         added.length
           ? added
               .map(([p, n]) => `<li>${esc(partnerName(p))}: ${n} passage${n === 1 ? "" : "s"}</li>`)
               .join("")
           : "<li>no partner passages — nothing of ours in this one</li>"
       }</ul>
       ${result.skipped.map(s => `<p style="color:#b00">${esc(s)}</p>`).join("")}
       <p><a href="/transcripts">See it on /transcripts</a></p>`
    )
  } catch (err) {
    return page(
      "Couldn't sort it",
      `<p>${esc(err instanceof Error ? err.message : String(err))}</p>
       <p>Try finishing on <a href="/transcripts">/transcripts</a>.</p>`,
      "warn"
    )
  }
}
