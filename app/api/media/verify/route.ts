import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/prisma"

// One-click confirm/reject from the weekly verification email. The token is
// the credential, same as the post draft approval flow.
function page(title: string, body: string) {
  return new NextResponse(
    `<html><body style="font-family:system-ui,sans-serif;padding:40px;max-width:560px;line-height:1.5">
      <h2 style="margin:0 0 8px">${title}</h2>
      ${body}
      <p style="color:#999;font-size:13px;margin-top:28px">Slow Ventures media tracker</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  )
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  const action = req.nextUrl.searchParams.get("action")

  if (!token || !action || !["confirm", "reject"].includes(action)) {
    return new NextResponse("Invalid request", { status: 400 })
  }

  const item = await prisma.mediaAppearance.findUnique({ where: { verifyToken: token } })
  if (!item) return new NextResponse("Not found", { status: 404 })

  if (item.verified || item.rejectedAt) {
    return page(
      "Already handled",
      `<p><strong>${item.show}</strong> — ${item.title}</p>
       <p>This was already marked <strong>${item.verified ? "confirmed" : "rejected"}</strong>.</p>`
    )
  }

  if (action === "reject") {
    await prisma.mediaAppearance.update({
      where: { id: item.id },
      data: { rejectedAt: new Date(), verifiedNote: "Rejected from the weekly email — mention not confirmed" },
    })
    return page(
      "Rejected",
      `<p><strong>${item.show}</strong> — ${item.title}</p>
       <p>It stays in the tracker for the record but is excluded from reporting and won't appear in the weekly reminder again.</p>`
    )
  }

  await prisma.mediaAppearance.update({
    where: { id: item.id },
    data: { verified: true, verifiedNote: "Confirmed by hand from the weekly email" },
  })
  return page(
    "Confirmed",
    `<p><strong>${item.show}</strong> — ${item.title}</p>
     <p>Marked as verified coverage.</p>`
  )
}
