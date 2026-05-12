import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import fs from "fs/promises"
import path from "path"
import { prisma } from "@/lib/db/prisma"

const BLACK = "#1E1E1E"
const WHITE = "#FFFFFF"

const PARTNER_DISPLAY: Record<string, { name: string; handle: string; title: string; org: string; photo: string }> = {
  sam: { name: "Sam Lessin", handle: "@lessin", title: "Co-Founder & General Partner", org: "Slow Ventures", photo: "sam.png" },
  will: { name: "Will Quist", handle: "@wquist", title: "General Partner", org: "Slow Ventures", photo: "will.jpg" },
  yoni: { name: "Yoni Rechtman", handle: "@yrechtman", title: "Partner", org: "Slow Ventures", photo: "yoni.jpg" },
  megan: { name: "Megan Lightcap", handle: "@mmlightcap", title: "Founder & Partner", org: "Slow Creator", photo: "megan.jpg" },
}

async function readAsBase64(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mime = ext === ".png" ? "image/png" : "image/jpeg"
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)

  // Support ?id=DRAFT_ID for short clean URLs (used by Zapier/LinkedIn)
  let partnerKey = searchParams.get("partner") || "sam"
  let quote = searchParams.get("quote") || "The market is pricing in what hasn't happened yet."

  const draftId = searchParams.get("id")
  if (draftId) {
    const draft = await prisma.postDraft.findUnique({ where: { id: draftId } })
    if (draft) {
      partnerKey = draft.partner
      quote = draft.partnerCitation
    }
  }

  const partner = PARTNER_DISPLAY[partnerKey] || PARTNER_DISPLAY.sam
  const displayQuote = quote.length > 260 ? quote.slice(0, 257) + "..." : quote

  const publicDir = path.join(process.cwd(), "public")

  const [bgSrc, photoSrc, fontRegular, fontMedium] = await Promise.all([
    readAsBase64(path.join(publicDir, "partners", "background.jpg")),
    readAsBase64(path.join(publicDir, "partners", partner.photo)),
    fs.readFile(path.join(publicDir, "fonts", "AkzidenzGroteskPro-Regular.otf")),
    fs.readFile(path.join(publicDir, "fonts", "AkzidenzGroteskPro-Md.otf")),
  ])

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
        }}
      >
        {/* Background image */}
        {bgSrc ? (
          <img
            src={bgSrc}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "flex",
            }}
          />
        ) : (
          <div style={{ position: "absolute", inset: 0, backgroundColor: "#F0EDE8", display: "flex" }} />
        )}

        {/* Content overlay */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1080,
            height: 1080,
            display: "flex",
            flexDirection: "column",
            padding: "72px 80px 64px 80px",
          }}
        >
          {/* Quote mark */}
          <div style={{ fontSize: 96, color: WHITE, lineHeight: 1, fontWeight: 500, opacity: 0.2, display: "flex", marginBottom: 8 }}>
            "
          </div>

          {/* Quote text — fills remaining vertical space */}
          <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
            <div
              style={{
                fontSize: displayQuote.length > 240 ? 52 : displayQuote.length > 160 ? 64 : displayQuote.length > 80 ? 78 : 96,
                color: WHITE,
                lineHeight: 1.06,
                fontWeight: 500,
                letterSpacing: "-0.05em",
                width: 920,
                fontFamily: "AkzidenzGrotesk",
              }}
            >
              {displayQuote}
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: 920, height: 2, backgroundColor: WHITE, opacity: 0.25, display: "flex", marginBottom: 28 }} />

          {/* Partner info */}
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 24 }}>
            {photoSrc && (
              <img
                src={photoSrc}
                width={96}
                height={96}
                style={{ borderRadius: 999, objectFit: "cover", display: "flex" }}
              />
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ color: WHITE, fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, display: "flex" }}>
                {partner.name}
              </span>
              <span style={{ color: WHITE, fontSize: 20, fontWeight: 400, lineHeight: 1.3, opacity: 0.8, display: "flex" }}>
                {partner.title} · {partner.org}
              </span>
              <span style={{ color: WHITE, fontSize: 18, fontWeight: 400, lineHeight: 1.3, opacity: 0.55, display: "flex" }}>
                {partner.handle}
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1080,
      height: 1080,
      fonts: [
        { name: "AkzidenzGrotesk", data: fontRegular, weight: 400, style: "normal" },
        { name: "AkzidenzGrotesk", data: fontMedium, weight: 500, style: "normal" },
      ],
    }
  )
}
