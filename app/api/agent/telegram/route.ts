import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"
import { publishDraft } from "@/lib/actions/publish"

export async function POST(req: NextRequest) {
  const body = await req.json()
  const message = body?.message
  if (!message) return NextResponse.json({ ok: true })

  const text = message?.text?.trim().toLowerCase()
  const chatId = message?.chat?.id?.toString()

  if (!text || chatId !== process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json({ ok: true })
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://slow-hackathon-xi.vercel.app"

  const sendMsg = async (msg: string) => {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    })
  }

  const sendQuoteCard = async (partner: string, quote: string) => {
    const url = `${appUrl}/api/quote-card?partner=${partner}&quote=${encodeURIComponent(quote.slice(0, 260))}`
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: url, caption: "Quote card preview" }),
    })
  }

  // Find the most recent pending draft
  const draft = await prisma.postDraft.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  })

  if (!draft) {
    await sendMsg("No pending drafts right now.")
    return NextResponse.json({ ok: true })
  }

  const showNextDraft = async () => {
    const next = await prisma.postDraft.findFirst({
      where: { status: "pending", id: { not: draft.id } },
      orderBy: { createdAt: "asc" },
    })
    if (next) {
      await sendMsg(`Next draft:\n\n─────────────────────\nTWITTER:\n\n${next.hook}\n\n─────────────────────\nLINKEDIN:\n\n${next.body}\n─────────────────────\n\nReply approve, approve twitter, approve linkedin, or reject.`)
      await sendQuoteCard(next.partner, next.body)
    } else {
      await sendMsg("No more pending drafts.")
    }
  }

  if (text === "approve" || text === "approve twitter" || text === "approve linkedin") {
    const onlyTwitter = text === "approve twitter"
    const onlyLinkedin = text === "approve linkedin"
    const results = await publishDraft({ ...draft, partner: draft.partner }, { onlyTwitter, onlyLinkedin })
    const twitterLine = onlyLinkedin ? "– Twitter skipped" : (results.twitter ? "✓ Twitter" : "✗ Twitter failed")
    const linkedinLine = onlyTwitter ? "– LinkedIn skipped" : (results.linkedin ? "✓ LinkedIn" : `✗ LinkedIn failed: ${results.linkedinError || "unknown"}`)
    await sendMsg(`Posted.\n${twitterLine}\n${linkedinLine}`)
    await showNextDraft()
  } else if (text === "reject") {
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { status: "rejected" },
    })
    await sendMsg("Draft rejected.")
    await showNextDraft()
  } else if (text.startsWith("feedback:")) {
    const note = text.replace("feedback:", "").trim()
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { feedback: note },
    })
    await sendMsg(`Got it. Saved: "${note}"\nThis will shape all future drafts.\n\nStill want to approve or reject this one?`)
  } else if (text === "next") {
    const next = await prisma.postDraft.findFirst({
      where: { status: "pending", id: { not: draft.id } },
      orderBy: { createdAt: "desc" },
    })
    if (!next) {
      await sendMsg("No other pending drafts.")
    } else {
      await sendMsg(`Next draft:\n\n${next.hook}\n\n${next.body}\n\nReply approve or reject.`)
    }
  } else {
    await sendMsg(`Reply with:\n• approve — post to both Twitter & LinkedIn\n• approve twitter — post to Twitter only\n• approve linkedin — post to LinkedIn only\n• reject — discard it\n• next — see next draft\n• feedback: [note] — teach the agent for next time`)
  }

  return NextResponse.json({ ok: true })
}
