import { NextRequest, NextResponse } from "next/server"
import * as cheerio from "cheerio"
import OpenAI from "openai"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { type Partner } from "@/lib/partners"

export const maxDuration = 60

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Reading inbound email needs a full-access key. The existing RESEND_API_KEY is
// send-only, so prefer a dedicated one and fall back for convenience.
const getResend = () =>
  new Resend(process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY)

// Matched against the sender address and subject line only
const SENDER_PATTERNS: [Partner, RegExp][] = [
  ["sam", /lessin|swl week in review/i],
  ["yoni", /99d|rechtman|\byoni\b/i],
  ["megan", /lightcap|slow upload|\bmegan\b/i],
  ["will", /quist/i],
]

// Where each partner's canonical post lives, so an emailed copy and a scraped
// copy collapse to the same row
const CANONICAL_URL: Record<Partner, RegExp> = {
  sam: /wlessin\.com\/p\//i,
  yoni: /99d\.substack\.com\/p\//i,
  megan: /meganlightcap\.com\/p\//i,
  will: /wquist\.com\/p\//i,
}

// Gmail's auto-forwarding does not always preserve the original sender, so fall
// back to looking for a partner's own post links in the body
function inferPartner(from: string, subject: string, html: string | null): Partner | null {
  const haystack = `${from} ${subject}`
  for (const [partner, pattern] of SENDER_PATTERNS) {
    if (pattern.test(haystack)) return partner
  }

  if (html) {
    for (const [partner, pattern] of Object.entries(CANONICAL_URL) as [Partner, RegExp][]) {
      if (pattern.test(html)) return partner
    }
  }

  return null
}

function parseNewsletter(html: string, partner: Partner): { content: string; postUrl: string | null } {
  const $ = cheerio.load(html)

  let postUrl: string | null = null
  $("a").each((_, el) => {
    if (postUrl) return
    const href = $(el).attr("href") ?? ""
    if (CANONICAL_URL[partner].test(href)) postUrl = href.split("?")[0]
  })

  $("script, style, head").remove()
  const content = $("body").text().replace(/\s+/g, " ").trim() || $.text().replace(/\s+/g, " ").trim()

  return { content, postUrl }
}

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

// ─── Forwarded press coverage ────────────────────────────────────────────────
// Forward any article, podcast or mention with "coverage" at the front of the
// subject and it lands in the media tracker, already verified — a human read it
// and chose to forward it, which is exactly the bar we hold this to.
const COVERAGE_SUBJECT = /^\s*(?:(?:re|fwd?)\s*:\s*)*coverage\b[:\-\s]*/i

function isCoverageForward(subject: string): boolean {
  return COVERAGE_SUBJECT.test(subject ?? "")
}

type CoverageFields = {
  partner: string | null
  type: string
  show: string
  title: string
  url: string | null
  publishedAt: string | null
  topics: string[]
  quote: string | null
}

// The forwarded chain is messy — headers, signatures, quoted replies. Let the
// model pull the fields out rather than trying to regex a mail client's output.
async function extractCoverage(subject: string, body: string): Promise<CoverageFields | null> {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You extract press coverage details from a forwarded email chain about a Slow Ventures partner.

Partners and how they may be referred to:
- "sam" = Sam Lessin
- "will" = Will Quist
- "yoni" = Yoni Rechtman
- "megan" = Megan Lightcap

Return JSON:
{
  "partner": "sam" | "will" | "yoni" | "megan" | null,
  "type": "press" | "podcast" | "panel" | "newsletter" | "video" | "other",
  "show": "outlet or show name, e.g. CNBC, Inc., Lenny's Podcast",
  "title": "headline or episode title",
  "url": "the single best link to the coverage itself, not a newsletter or unsubscribe link",
  "publishedAt": "YYYY-MM-DD or null if not stated",
  "topics": ["3-5 lowercase topic tags"],
  "quote": "a verbatim quote from the partner if the email contains one, else null"
}

Rules: never invent a URL or a date. If the partner is unclear, return null for partner. Prefer the outlet's own domain over aggregators.`,
        },
        { role: "user", content: `Subject: ${subject}\n\n${body.slice(0, 12000)}` },
      ],
    })
    return JSON.parse(res.choices[0].message.content ?? "{}") as CoverageFields
  } catch (err) {
    console.error("[inbound] coverage extraction failed:", err)
    return null
  }
}

async function rememberUnmatched(from: string, subject: string, text: string, receivedAt: string) {
  const value = JSON.stringify({ from, subject, text: text.slice(0, 2000), receivedAt })
  await prisma.appSetting.upsert({
    where: { key: "inbound_unmatched" },
    update: { value },
    create: { key: "inbound_unmatched", value },
  })
}

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: "RESEND_WEBHOOK_SECRET not set" }, { status: 500 })
  }

  const resend = getResend()
  const raw = await req.text()

  let event
  try {
    event = resend.webhooks.verify({
      payload: raw,
      headers: {
        id: req.headers.get("svix-id") ?? "",
        timestamp: req.headers.get("svix-timestamp") ?? "",
        signature: req.headers.get("svix-signature") ?? "",
      },
      webhookSecret: secret,
    })
  } catch (err) {
    console.error("[inbound] signature verification failed:", err)
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ ok: true, ignored: event.type })
  }

  const emailId = (event.data as { email_id?: string }).email_id
  if (!emailId) {
    return NextResponse.json({ error: "No email_id in payload" }, { status: 400 })
  }

  // Webhooks carry metadata only — the body comes from the receiving API
  const { data: email, error } = await resend.emails.receiving.get(emailId)
  if (error || !email) {
    console.error(`[inbound] could not fetch ${emailId}:`, error)
    return NextResponse.json({ error: error?.message ?? "Fetch failed" }, { status: 502 })
  }

  // Coverage forwards are handled before newsletter ingestion — the subject
  // prefix is the switch, so a forwarded article never lands in the content
  // library as if the partner had written it.
  if (isCoverageForward(email.subject ?? "")) {
    const bodyText =
      email.text ??
      (email.html ? cheerio.load(email.html).text().replace(/\s+/g, " ").trim() : "")
    const c = await extractCoverage(email.subject ?? "", bodyText)

    if (!c?.url || !c.partner) {
      await rememberUnmatched(email.from, email.subject, bodyText, email.created_at)
      return NextResponse.json({
        ok: true,
        coverage: true,
        stored: false,
        reason: !c?.url ? "no article URL found in the forward" : "could not tell which partner",
      })
    }

    const dupe = await prisma.mediaAppearance.findFirst({ where: { url: c.url }, select: { id: true } })
    if (dupe) {
      return NextResponse.json({ ok: true, coverage: true, stored: false, reason: "already tracked", url: c.url })
    }

    await prisma.mediaAppearance.create({
      data: {
        partner: c.partner,
        type: c.type || "press",
        show: c.show || "Unknown outlet",
        title: c.title || email.subject || "Untitled",
        url: c.url,
        publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
        topics: Array.isArray(c.topics) ? c.topics : [],
        notes: c.quote ? `Quote: ${c.quote}` : null,
        status: "ready",
        // Forwarded by a human who already checked it, so it skips the queue.
        verified: true,
        verifiedNote: `Forwarded by ${email.from} on ${email.created_at?.slice(0, 10) ?? "unknown date"}`,
      },
    })

    return NextResponse.json({
      ok: true,
      coverage: true,
      stored: true,
      partner: c.partner,
      show: c.show,
      url: c.url,
    })
  }

  const partner = inferPartner(email.from, email.subject, email.html)

  // Anything we can't attribute — including Gmail's forwarding confirmation
  // code — is parked here so it can be read back via GET
  if (!partner) {
    await rememberUnmatched(email.from, email.subject, email.text ?? "", email.created_at)
    console.log(`[inbound] unmatched sender: ${email.from} — "${email.subject}"`)
    return NextResponse.json({ ok: true, matched: false, from: email.from, subject: email.subject })
  }

  const parsed = email.html
    ? parseNewsletter(email.html, partner)
    : { content: (email.text ?? "").replace(/\s+/g, " ").trim(), postUrl: null }

  if (parsed.content.length < 200) {
    return NextResponse.json({ ok: true, matched: partner, stored: false, reason: "body too short" })
  }

  const sourceUrl = parsed.postUrl ?? `email:${email.message_id || emailId}`
  const existing = await prisma.partnerContent.findFirst({ where: { sourceUrl } })
  if (existing) {
    return NextResponse.json({ ok: true, matched: partner, stored: false, reason: "already ingested" })
  }

  const embedding = await embed(parsed.content)
  await prisma.partnerContent.create({
    data: {
      partner,
      sourceType: "newsletter",
      sourceUrl,
      title: email.subject || null,
      content: parsed.content,
      embedding,
      publishedAt: email.created_at ? new Date(email.created_at) : null,
    },
  })

  return NextResponse.json({
    ok: true,
    matched: partner,
    stored: true,
    title: email.subject,
    chars: parsed.content.length,
    sourceUrl,
  })
}

// Read back the last email we couldn't attribute — used to grab Gmail's
// forwarding confirmation code during setup
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const row = await prisma.appSetting.findUnique({ where: { key: "inbound_unmatched" } })
  return NextResponse.json(row ? JSON.parse(row.value) : { message: "No unmatched emails received yet" })
}
