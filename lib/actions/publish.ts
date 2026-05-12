"use server"

import { prisma } from "@/lib/db/prisma"

export async function publishDraft(
  draft: {
    id: string
    hook: string
    body: string
    videoId: string | null
    quoteTweetId?: string | null
    partnerSourceUrl?: string | null
    source?: string | null
  },
  options: { onlyTwitter?: boolean; onlyLinkedin?: boolean } = {}
) {
  const twitterText = draft.hook
  const linkedinText = draft.body
  const results: { twitter: boolean; linkedin: boolean; linkedinError?: string } = { twitter: false, linkedin: false }

  // Skip quote-tweet for announcement posts
  const useQuoteTweet = draft.source !== "announcement"

  if (!options.onlyLinkedin) {
    const twitterKey = process.env.TWITTER_API_KEY
    const twitterSecret = process.env.TWITTER_API_SECRET
    const twitterToken = process.env.TWITTER_ACCESS_TOKEN
    const twitterTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET

    if (twitterKey && twitterSecret && twitterToken && twitterTokenSecret) {
      try {
        const tweetPayload: Record<string, unknown> = { text: twitterText.slice(0, 280) }
        if (useQuoteTweet && draft.quoteTweetId) tweetPayload.quote_tweet_id = draft.quoteTweetId
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
        if (!res.ok) {
          console.error("Twitter error:", await res.text())
        } else if (draft.partnerSourceUrl) {
          const tweetData = await res.json()
          const mainTweetId = tweetData?.data?.id
          if (mainTweetId) {
            const replyText = `Full thinking here: ${draft.partnerSourceUrl}`
            const replyPayload = JSON.stringify({
              text: replyText,
              reply: { in_reply_to_tweet_id: mainTweetId },
            })
            const replyAuth = await buildTwitterOAuthHeader(
              "POST", "https://api.twitter.com/2/tweets", replyPayload,
              { twitterKey, twitterSecret, twitterToken, twitterTokenSecret }
            )
            await fetch("https://api.twitter.com/2/tweets", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: replyAuth },
              body: replyPayload,
            })
          }
        }
      } catch (e) {
        console.error("Twitter publish error:", e)
      }
    }
  }

  if (!options.onlyTwitter) {
    const zapierUrl = process.env.ZAPIER_LINKEDIN_WEBHOOK
    if (zapierUrl) {
      try {
        const res = await fetch(zapierUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: linkedinText }),
        })
        results.linkedin = res.ok
        if (!res.ok) {
          const errText = await res.text()
          console.error("Zapier LinkedIn error:", res.status, errText)
          results.linkedinError = `${res.status}: ${errText}`
        }
      } catch (e) {
        console.error("Zapier LinkedIn publish error:", e)
        results.linkedinError = String(e)
      }
    } else {
      results.linkedinError = "ZAPIER_LINKEDIN_WEBHOOK not set"
    }
  }

  await prisma.postDraft.update({
    where: { id: draft.id },
    data: { status: "published", publishedAt: new Date() },
  })

  return results
}

export async function sendTelegramMessage(text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) return
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
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
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: keys.twitterToken,
    oauth_version: "1.0",
  }
  const paramString = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&")
  const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramString)].join("&")
  const signingKey = `${encodeURIComponent(keys.twitterSecret)}&${encodeURIComponent(keys.twitterTokenSecret)}`
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(signingKey), { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(baseString))
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
  params["oauth_signature"] = signature
  return "OAuth " + Object.keys(params).map(k => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`).join(", ")
}
