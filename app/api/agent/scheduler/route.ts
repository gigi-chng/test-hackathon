import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"
import { publishDraft, sendTelegramMessage } from "@/lib/actions/publish"

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-vercel-cron-secret") ?? new URL(req.url).searchParams.get("secret")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()

  const due = await prisma.postDraft.findMany({
    where: {
      status: "scheduled",
      scheduledAt: { lte: now },
    },
  })

  if (due.length === 0) return NextResponse.json({ posted: 0 })

  let posted = 0
  for (const draft of due) {
    const results = await publishDraft(
      {
        id: draft.id,
        hook: draft.hook,
        body: draft.body,
        videoId: draft.videoId,
        quoteTweetId: draft.quoteTweetId,
        partnerSourceUrl: draft.partnerSourceUrl,
        source: draft.source,
      },
      {
        onlyTwitter: draft.platform === "twitter",
        onlyLinkedin: draft.platform === "linkedin",
      }
    )

    const twitterLine = draft.platform === "linkedin" ? "– Twitter skipped" : (results.twitter ? "✓ Twitter" : "✗ Twitter failed")
    const linkedinLine = draft.platform === "twitter" ? "– LinkedIn skipped" : (results.linkedin ? "✓ LinkedIn" : `✗ LinkedIn failed: ${results.linkedinError || "unknown"}`)
    await sendTelegramMessage(`📣 Scheduled post published.\n${twitterLine}\n${linkedinLine}`)
    posted++
  }

  return NextResponse.json({ posted })
}
