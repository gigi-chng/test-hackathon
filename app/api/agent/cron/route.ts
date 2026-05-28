import { NextRequest, NextResponse } from "next/server"
import { runAgentPipeline } from "@/lib/actions/trends"
import { syncDriveFolder } from "@/lib/actions/drive-sync"
import { prisma } from "@/lib/db/prisma"
import { publishDraft, sendTelegramMessage } from "@/lib/actions/publish"

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Check for scheduled posts due to go out
  const due = await prisma.postDraft.findMany({
    where: { status: "scheduled", scheduledAt: { lte: new Date() } },
  })
  for (const draft of due) {
    const results = await publishDraft(draft, {
      onlyTwitter: draft.platform === "twitter",
      onlyLinkedin: draft.platform === "linkedin",
    })
    const twitterLine = draft.platform === "linkedin" ? "– Twitter skipped" : (results.twitter ? "✓ Twitter" : "✗ Twitter failed")
    const linkedinLine = draft.platform === "twitter" ? "– LinkedIn skipped" : (results.linkedin ? "✓ LinkedIn" : `✗ LinkedIn failed: ${results.linkedinError || "unknown"}`)
    await sendTelegramMessage(`📣 Scheduled post published.\n${twitterLine}\n${linkedinLine}`)
  }

  // Sync new videos from Drive
  try {
    const sync = await syncDriveFolder()
    if (sync.added > 0) {
      await sendTelegramMessage(`📹 Drive sync: ${sync.added} new video${sync.added !== 1 ? "s" : ""} added to library`)
    }
  } catch (e) {
    console.error("Drive sync error (non-blocking):", e)
  }

  try {
    const result = await runAgentPipeline()
    return NextResponse.json({ ok: true, scheduled: due.length, ...result })
  } catch (e) {
    console.error("Agent pipeline error:", e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
