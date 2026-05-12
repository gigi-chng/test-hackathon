import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import fs from "fs/promises"
import path from "path"
import { prisma } from "@/lib/db/prisma"

const BLACK = "#1E1E1E"

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
            width: 1200,
            height: 628,
            display: "flex",
            flexDirection: "column",
            padding: "52px 80px 52px 80px",
            gap: 20,
          }}
        >
          {/* Quote mark */}
          <div style={{ fontSize: 72, color: BLACK, lineHeight: 1, fontWeight: 500, opacity: 0.15, display: "flex" }}>
            "
          </div>

          {/* Quote text — Akzidenz Grotesk Medium */}
          <div
            style={{
              fontSize: displayQuote.length > 200 ? 26 : displayQuote.length > 120 ? 30 : 38,
              color: BLACK,
              lineHeight: 1.05,
              fontWeight: 500,
              letterSpacing: "-0.05em",
              width: 1040,
              fontFamily: "AkzidenzGrotesk",
            }}
          >
            {displayQuote}
          </div>

          {/* Divider */}
          <div style={{ width: 1040, height: 1, backgroundColor: BLACK, opacity: 0.15, display: "flex" }} />

          {/* Partner info */}
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 16 }}>
            {photoSrc && (
              <img
                src={photoSrc}
                width={52}
                height={52}
                style={{ borderRadius: 999, objectFit: "cover", display: "flex" }}
              />
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: BLACK, fontSize: 18, fontWeight: 500, letterSpacing: "0", lineHeight: 1.2, display: "flex" }}>
                {partner.name}
              </span>
              <span style={{ color: BLACK, fontSize: 12, fontWeight: 400, lineHeight: 1.3, opacity: 0.65, display: "flex" }}>
                {partner.title} · {partner.org}
              </span>
              <span style={{ color: BLACK, fontSize: 11, fontWeight: 400, lineHeight: 1.3, opacity: 0.45, display: "flex" }}>
                {partner.handle}
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 628,
      fonts: [
        { name: "AkzidenzGrotesk", data: fontRegular, weight: 400, style: "normal" },
        { name: "AkzidenzGrotesk", data: fontMedium, weight: 500, style: "normal" },
      ],
    }
  )
}
