import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export async function POST(req: NextRequest) {
  const body = await req.json()
  const message = body?.message
  if (!message) return NextResponse.json({ ok: true })

  const text = message?.text?.trim().toLowerCase()
  const chatId = message?.chat?.id?.toString()

  if (!text || chatId !== process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json({ ok: true })
  }

  // Find the most recent pending draft
  const draft = await prisma.postDraft.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  })

  if (!draft) {
    await sendTelegramMessage(chatId, "No pending drafts right now.")
    return NextResponse.json({ ok: true })
  }

  if (text === "approve") {
    const results = await publishDraft(draft)
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { status: "published", publishedAt: new Date() },
    })
    await sendTelegramMessage(
      chatId,
      `Posted.\n${results.twitter ? "✓ Twitter" : "✗ Twitter failed"}\n${results.linkedin ? "✓ LinkedIn" : `✗ LinkedIn failed: ${results.linkedinError || "unknown"}`}`
    )
  } else if (text === "reject") {
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { status: "rejected" },
    })
    await sendTelegramMessage(chatId, "Draft rejected.")
  } else if (text.startsWith("feedback:")) {
    const note = text.replace("feedback:", "").trim()
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { feedback: note },
    })
    await sendTelegramMessage(chatId, `Got it. Saved: "${note}"\nThis will shape all future drafts.\n\nStill want to approve or reject this one?`)
  } else if (text === "next") {
    // Show the next pending draft if multiple exist
    const next = await prisma.postDraft.findFirst({
      where: { status: "pending", id: { not: draft.id } },
      orderBy: { createdAt: "desc" },
    })
    if (!next) {
      await sendTelegramMessage(chatId, "No other pending drafts.")
    } else {
      await sendTelegramMessage(chatId, `Next draft:\n\n${next.hook}\n\n${next.body}\n\nReply approve or reject.`)
    }
  } else {
    await sendTelegramMessage(chatId, `Reply with:\n• approve — post the draft\n• reject — discard it\n• next — see next draft\n• feedback: [note] — teach the agent for next time`)
  }

  return NextResponse.json({ ok: true })
}

async function sendTelegramMessage(chatId: string, text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}

async function publishDraft(draft: { hook: string; body: string; videoId: string | null; quoteTweetId?: string | null }) {
  const twitterText = draft.hook  // hook = twitter post
  const linkedinText = draft.body // body = linkedin post
  const results: { twitter: boolean; linkedin: boolean; linkedinError?: string } = { twitter: false, linkedin: false }

  const twitterKey = process.env.TWITTER_API_KEY
  const twitterSecret = process.env.TWITTER_API_SECRET
  const twitterToken = process.env.TWITTER_ACCESS_TOKEN
  const twitterTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET

  if (twitterKey && twitterSecret && twitterToken && twitterTokenSecret) {
    try {
      const tweetPayload: Record<string, unknown> = { text: twitterText.slice(0, 280) }
      if (draft.quoteTweetId) tweetPayload.quote_tweet_id = draft.quoteTweetId
      const body = JSON.stringify(tweetPayload)
      const authHeader = await buildTwitterOAuthHeader(
        "POST", "https://api.twitter.com/2/tweets", body,
        { twitterKey, twitterSecret, twitterToken, twitterTokenSecret }
      )
      const res = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body,
      })
      results.twitter = res.ok
      if (!res.ok) console.error("Twitter error:", await res.text())
    } catch (e) {
      console.error("Twitter publish error:", e)
    }
  }

  const linkedinToken = process.env.LINKEDIN_ACCESS_TOKEN
  const linkedinOrgId = process.env.LINKEDIN_ORG_ID
  if (linkedinToken && linkedinOrgId) {
    try {
      const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${linkedinToken}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: `urn:li:organization:${linkedinOrgId}`,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text: linkedinText },
              shareMediaCategory: "NONE",
            },
          },
          visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
        }),
      })
      results.linkedin = res.ok
      if (!res.ok) {
        const errText = await res.text()
        console.error("LinkedIn error:", res.status, errText)
        results.linkedinError = `${res.status}: ${errText}`
      }
    } catch (e) {
      console.error("LinkedIn publish error:", e)
      results.linkedinError = String(e)
    }
  } else {
    results.linkedinError = `missing: token=${!!linkedinToken} orgId=${!!linkedinOrgId}`
  }

  return results
}

async function buildTwitterOAuthHeader(
  method: string, url: string, body: string,
  keys: { twitterKey: string; twitterSecret: string; twitterToken: string; twitterTokenSecret: string }
): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "")
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const params: Record<string, string> = {
    oauth_consumer_key: keys.twitterKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: timestamp,
    oauth_token: keys.twitterToken,
    oauth_version: "1.0",
  }
  const paramString = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&")
  const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramString)].join("&")
  const signingKey = `${encodeURIComponent(keys.twitterSecret)}&${encodeURIComponent(keys.twitterTokenSecret)}`
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(baseString))
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
  params["oauth_signature"] = signature
  return "OAuth " + Object.keys(params).map(k => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`).join(", ")
}
