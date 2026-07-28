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

function inferPartner(from: string, subject: string): Partner | null {
  const haystack = `${from} ${subject}`
  for (const [partner, pattern] of SENDER_PATTERNS) {
    if (pattern.test(haystack)) return partner
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

  const partner = inferPartner(email.from, email.subject)

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
