import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"
import { publishDraft } from "@/lib/actions/publish"

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

