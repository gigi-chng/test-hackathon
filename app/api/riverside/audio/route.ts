import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/prisma"
import { fetchFile, RiversideAuthError } from "@/lib/riverside"

export const maxDuration = 300

/**
 * Stream one speaker's audio track out of Riverside.
 *
 * Riverside's own download URLs need the workspace API key, so they can't be
 * put in an email. This proxies them behind our login instead: the "who is
 * this?" email links here, /api/riverside is not in proxy.ts's publicRoutes,
 * so an unauthenticated click lands on sign-in with a callbackUrl and comes
 * straight back.
 *
 * Only file ids already recorded on a transcript row are accepted, so this
 * can't be used to walk arbitrary files in the workspace.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const transcriptId = req.nextUrl.searchParams.get("t")
  const speaker = req.nextUrl.searchParams.get("s")
  if (!transcriptId || !speaker) {
    return NextResponse.json({ error: "Missing t or s" }, { status: 400 })
  }

  const row = await prisma.transcript.findUnique({
    where: { id: transcriptId },
    select: { speakerMedia: true, title: true },
  })
  if (!row) {
    return NextResponse.json({ error: "Transcript not found" }, { status: 404 })
  }

  const media = (row.speakerMedia ?? {}) as Record<string, string>
  const fileId = media[speaker]
  if (!fileId) {
    return NextResponse.json(
      { error: `No audio stored for speaker "${speaker}"` },
      { status: 404 }
    )
  }

  try {
    const upstream = await fetchFile(fileId)
    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
        // Play in the browser rather than downloading a file to identify.
        "Content-Disposition": `inline; filename="${speaker}.audio"`,
        ...(upstream.headers.get("content-length")
          ? { "Content-Length": upstream.headers.get("content-length")! }
          : {}),
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch (err) {
    if (err instanceof RiversideAuthError) {
      return NextResponse.json(
        { error: "Riverside rejected the API key — it was probably rotated" },
        { status: 502 }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    )
  }
}
