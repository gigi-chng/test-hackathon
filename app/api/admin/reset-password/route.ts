import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { prisma } from "@/lib/db/prisma"

export const maxDuration = 30

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://slow-hackathon-xi.vercel.app"

/**
 * Issue a one-time password reset link.
 *
 * There is no self-serve reset in this app, and passwords are bcrypt hashed,
 * so a forgotten one is unrecoverable without something like this. Guarded by
 * CRON_SECRET like the other admin routes.
 *
 * Deliberately returns a link rather than accepting a password: whoever runs
 * this never learns the password, and it never lands in a shell history or a
 * request log.
 *
 *   GET ?list=1        -> which accounts exist (addresses only, no hashes)
 *   GET ?email=<addr>  -> a reset link, valid 30 minutes, single use
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (req.nextUrl.searchParams.get("list") === "1") {
    const users = await prisma.user.findMany({
      select: { email: true, name: true, password: true, emailVerified: true },
    })
    return NextResponse.json({
      ok: true,
      users: users.map(u => ({
        email: u.email,
        name: u.name,
        hasPassword: Boolean(u.password),
      })),
    })
  }

  const email = req.nextUrl.searchParams.get("email")?.trim()
  if (!email) {
    return NextResponse.json({ error: "Pass ?email= or ?list=1" }, { status: 400 })
  }

  const token = randomBytes(32).toString("hex")
  const expires = new Date(Date.now() + 30 * 60 * 1000)

  // Reuses the Auth.js verification_tokens table, which is exactly this shape.
  await prisma.verificationToken.create({
    data: { identifier: email.toLowerCase(), token, expires },
  })

  // Invalidate anything older for this address so only the newest link works.
  await prisma.verificationToken.deleteMany({
    where: { identifier: email.toLowerCase(), token: { not: token } },
  })

  return NextResponse.json({
    ok: true,
    email: email.toLowerCase(),
    expiresAt: expires.toISOString(),
    url: `${BASE}/reset-password?token=${token}`,
  })
}
