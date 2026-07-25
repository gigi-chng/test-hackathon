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

  // Approve — mark as approved (no auto-publish)
  await prisma.postDraft.update({
    where: { id: draft.id },
    data: { status: "approved" },
  })

  return new NextResponse(
    `<html><body style="font-family:sans-serif;padding:40px;max-width:500px">
      <h2>Draft approved</h2>
      <p>The draft has been marked as approved.</p>
      <p style="margin-top:24px;font-size:13px;color:#888;">"${draft.hook}"</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  )
}
