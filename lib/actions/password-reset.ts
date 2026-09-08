"use server"

import bcrypt from "bcryptjs"
import { AuthError } from "next-auth"
import { signIn } from "@/auth"
import { prisma } from "@/lib/db/prisma"

/**
 * Finish a password reset started from /api/admin/reset-password.
 *
 * There is no self-serve "forgot password" in this app, so the recovery path
 * is a one-time link issued with the admin secret. The token is the whole
 * credential here, so it is single-use and checked for expiry before anything
 * is written.
 *
 * The address is stored lowercased. Sign-up keeps whatever case was typed,
 * which is how "Gigi@slow.co" and "gigi@slow.co" ended up as two accounts.
 */
export async function completePasswordReset(
  formData: FormData
): Promise<{ error?: string } | undefined> {
  const token = String(formData.get("token") ?? "")
  const password = String(formData.get("password") ?? "")
  const confirm = String(formData.get("confirm") ?? "")

  if (!token) return { error: "This link is missing its token." }
  if (password.length < 6) return { error: "Password must be at least 6 characters." }
  if (password !== confirm) return { error: "The two passwords don't match." }

  const record = await prisma.verificationToken.findFirst({ where: { token } })
  if (!record) return { error: "This link has already been used, or isn't valid." }

  if (record.expires < new Date()) {
    await prisma.verificationToken.delete({
      where: { identifier_token: { identifier: record.identifier, token } },
    })
    return { error: "This link has expired. Ask for a new one." }
  }

  const email = record.identifier.toLowerCase()
  const hashed = await bcrypt.hash(password, 10)

  // Covers both cases in one path: an existing account gets a new password, and
  // an email with no account yet gets one created.
  const existing = await prisma.user.findFirst({ where: { email } })
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { password: hashed } })
  } else {
    await prisma.user.create({ data: { email, password: hashed, name: "Gigi" } })
  }

  // Single use, whatever happens next.
  await prisma.verificationToken.delete({
    where: { identifier_token: { identifier: record.identifier, token } },
  })

  try {
    await signIn("credentials", { email, password, redirectTo: "/reactions" })
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Password set, but sign-in failed. Try signing in directly." }
    }
    throw err
  }
}
