import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  const action = req.nextUrl.searchParams.get("action")

  if (!token || !action || !["approve", "reject"].includes(action)) {
    return new NextResponse("Invalid request", { status: 400 })
  }

  const draft = await prisma.postDraft.findUnique({
    where: { approvalToken: token },
  })

  if (!draft) {
    return new NextResponse("Draft not found", { status: 404 })
  }

  if (draft.status !== "pending") {
    return new NextResponse(
      `<html><body style="font-family:sans-serif;padding:40px;max-width:500px">
        <h2>Already handled</h2>
        <p>This draft was already <strong>${draft.status}</strong>.</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    )
  }

  if (action === "reject") {
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { status: "rejected" },
    })
    return new NextResponse(
      `<html><body style="font-family:sans-serif;padding:40px;max-width:500px">
        <h2>Draft rejected</h2>
        <p>The draft has been discarded.</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    )
  }

  // Approve — publish to Twitter + LinkedIn
  try {
    const results = await publishDraft(draft)
    await prisma.postDraft.update({
      where: { id: draft.id },
      data: { status: "published", publishedAt: new Date() },
    })

    return new NextResponse(
      `<html><body style="font-family:sans-serif;padding:40px;max-width:500px">
        <h2>Published</h2>
        <p>${results.twitter ? "✓ Posted to Twitter" : "✗ Twitter failed"}</p>
        <p>${results.linkedin ? "✓ Posted to LinkedIn" : "✗ LinkedIn failed"}</p>
        <p style="margin-top:24px;font-size:13px;color:#888;">Post: "${draft.hook}"</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    )
  } catch (e) {
    console.error("Publish failed:", e)
    return new NextResponse(
      `<html><body style="font-family:sans-serif;padding:40px;max-width:500px">
        <h2>Publish failed</h2>
        <p>Check server logs for details.</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    )
  }
}

async function publishDraft(draft: {
  hook: string
  body: string
  videoId: string | null
}): Promise<{ twitter: boolean; linkedin: boolean }> {
  const postText = `${draft.hook}\n\n${draft.body}`
  const results = { twitter: false, linkedin: false }

  // ── Twitter ───────────────────────────────────────────────────────────────
  const twitterKey = process.env.TWITTER_API_KEY
  const twitterSecret = process.env.TWITTER_API_SECRET
  const twitterToken = process.env.TWITTER_ACCESS_TOKEN
  const twitterTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET

  if (twitterKey && twitterSecret && twitterToken && twitterTokenSecret) {
    try {
      const body = JSON.stringify({ text: postText.slice(0, 280) })
      const authHeader = await buildTwitterOAuthHeader("POST", "https://api.twitter.com/2/tweets", body, {
        twitterKey, twitterSecret, twitterToken, twitterTokenSecret,
      })

      const res = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body,
      })
      results.twitter = res.ok
    } catch (e) {
      console.error("Twitter publish error:", e)
    }
  }

  // ── LinkedIn ──────────────────────────────────────────────────────────────
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
              shareCommentary: { text: postText },
              shareMediaCategory: "NONE",
            },
          },
          visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
        }),
      })
      results.linkedin = res.ok
    } catch (e) {
      console.error("LinkedIn publish error:", e)
    }
  }

  return results
}

// ── Twitter OAuth 1.0a helper ──────────────────────────────────────────────

async function buildTwitterOAuthHeader(
  method: string,
  url: string,
  body: string,
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

  const paramString = Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&")

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString),
  ].join("&")

  const signingKey = `${encodeURIComponent(keys.twitterSecret)}&${encodeURIComponent(keys.twitterTokenSecret)}`

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(baseString))
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))

  params["oauth_signature"] = signature

  return "OAuth " + Object.keys(params)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`)
    .join(", ")
}
