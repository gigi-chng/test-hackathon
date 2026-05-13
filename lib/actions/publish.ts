"use server"

import { prisma } from "@/lib/db/prisma"

// Upload a video to Twitter using chunked media upload (v1.1 API)
async function uploadVideoToTwitter(
  videoUrl: string,
  keys: { twitterKey: string; twitterSecret: string; twitterToken: string; twitterTokenSecret: string }
): Promise<string | null> {
  try {
    // Download from Google Drive
    const driveFileId = videoUrl.match(/\/d\/([^/]+)\//)?.[1]
    if (!driveFileId) return null
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${driveFileId}&confirm=t`
    const videoRes = await fetch(downloadUrl)
    if (!videoRes.ok) return null
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer())
    const totalBytes = videoBuffer.length

    const oauthHeaders = async (method: string, url: string, params: Record<string, string>) => {
      const nonce = crypto.randomUUID().replace(/-/g, "")
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const oauthParams: Record<string, string> = {
        oauth_consumer_key: keys.twitterKey,
        oauth_nonce: nonce,
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: timestamp,
        oauth_token: keys.twitterToken,
        oauth_version: "1.0",
      }
      const allParams = { ...oauthParams, ...params }
      const paramString = Object.keys(allParams).sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join("&")
      const baseString = [method, encodeURIComponent(url), encodeURIComponent(paramString)].join("&")
      const signingKey = `${encodeURIComponent(keys.twitterSecret)}&${encodeURIComponent(keys.twitterTokenSecret)}`
      const enc = new TextEncoder()
      const key = await crypto.subtle.importKey("raw", enc.encode(signingKey), { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(baseString))
      oauthParams["oauth_signature"] = btoa(String.fromCharCode(...new Uint8Array(sig)))
      return "OAuth " + Object.keys(oauthParams).map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`).join(", ")
    }

    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json"

    // INIT
    const initParams = { command: "INIT", total_bytes: String(totalBytes), media_type: "video/mp4", media_category: "tweet_video" }
    const initAuth = await oauthHeaders("POST", uploadUrl, initParams)
    const initBody = new URLSearchParams(initParams)
    const initRes = await fetch(uploadUrl, { method: "POST", headers: { Authorization: initAuth, "Content-Type": "application/x-www-form-urlencoded" }, body: initBody })
    if (!initRes.ok) { console.error("Twitter media INIT failed:", await initRes.text()); return null }
    const { media_id_string: mediaId } = await initRes.json()

    // APPEND in 5MB chunks
    const chunkSize = 5 * 1024 * 1024
    for (let i = 0; i * chunkSize < totalBytes; i++) {
      const chunk = videoBuffer.slice(i * chunkSize, (i + 1) * chunkSize)
      const appendAuth = await oauthHeaders("POST", uploadUrl, { command: "APPEND", media_id: mediaId, segment_index: String(i) })
      const form = new FormData()
      form.append("command", "APPEND")
      form.append("media_id", mediaId)
      form.append("segment_index", String(i))
      form.append("media", new Blob([chunk], { type: "video/mp4" }))
      await fetch(uploadUrl, { method: "POST", headers: { Authorization: appendAuth }, body: form })
    }

    // FINALIZE
    const finalParams = { command: "FINALIZE", media_id: mediaId }
    const finalAuth = await oauthHeaders("POST", uploadUrl, finalParams)
    const finalRes = await fetch(uploadUrl, { method: "POST", headers: { Authorization: finalAuth, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(finalParams) })
    if (!finalRes.ok) { console.error("Twitter media FINALIZE failed:", await finalRes.text()); return null }
    const finalData = await finalRes.json()

    // Poll for processing completion
    let state = finalData?.processing_info?.state
    let waitSecs = finalData?.processing_info?.check_after_secs ?? 5
    while (state === "pending" || state === "in_progress") {
      await new Promise(r => setTimeout(r, waitSecs * 1000))
      const statusAuth = await oauthHeaders("GET", uploadUrl, { command: "STATUS", media_id: mediaId })
      const statusRes = await fetch(`${uploadUrl}?command=STATUS&media_id=${mediaId}`, { headers: { Authorization: statusAuth } })
      const statusData = await statusRes.json()
      state = statusData?.processing_info?.state
      waitSecs = statusData?.processing_info?.check_after_secs ?? 5
    }
    if (state === "failed") { console.error("Twitter media processing failed"); return null }

    return mediaId
  } catch (e) {
    console.error("Video upload error:", e)
    return null
  }
}

export async function publishDraft(
  draft: {
    id: string
    hook: string
    body: string
    partner?: string | null
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
        // Upload video if one is attached
        let mediaId: string | null = null
        if (draft.videoId) {
          const video = await prisma.videoLibrary.findUnique({ where: { id: draft.videoId }, select: { storageUrl: true } })
          if (video?.storageUrl) {
            mediaId = await uploadVideoToTwitter(video.storageUrl, { twitterKey, twitterSecret, twitterToken, twitterTokenSecret })
          }
        }

        const tweetPayload: Record<string, unknown> = { text: twitterText.slice(0, 280) }
        if (useQuoteTweet && draft.quoteTweetId) tweetPayload.quote_tweet_id = draft.quoteTweetId
        if (mediaId) tweetPayload.media = { media_ids: [mediaId] }
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
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://slow-hackathon-xi.vercel.app"
        const quoteCardUrl = draft.partner ? `${baseUrl}/api/quote-card?id=${draft.id}` : null

        const res = await fetch(zapierUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: linkedinText, quoteCardUrl }),
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
