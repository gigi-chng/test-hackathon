"use server"

import { signIn } from "@/auth"
import { prisma } from "@/lib/db/prisma"
import bcrypt from "bcryptjs"
import { AuthError } from "next-auth"

export async function signUp(formData: FormData) {
  const name = formData.get("name") as string
  const email = formData.get("email") as string
  const password = formData.get("password") as string

  if (!email || !password) {
    return { error: "Email and password are required" }
  }

  if (password.length < 6) {
    return { error: "Password must be at least 6 characters" }
  }

  // Stored lowercased so one address can't become two accounts.
  const normalized = email.trim().toLowerCase()

  const existing = await prisma.user.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" } },
  })

  if (existing) {
    return { error: "An account with this email already exists" }
  }

  const hashed = await bcrypt.hash(password, 10)

  await prisma.user.create({
    data: {
      name: name || null,
      email: normalized,
      password: hashed,
    },
  })

  try {
    await signIn("credentials", {
      email: normalized,
      password,
      redirectTo: "/protected",
    })
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Failed to sign in after registration" }
    }
    throw error
  }
}

export async function signInWithCredentials(formData: FormData) {
  const email = (formData.get("email") as string)?.trim()
  const password = formData.get("password") as string

  if (!email || !password) {
    return { error: "Email and password are required" }
  }

  // One message for every failure meant a mistyped address, an account that
  // didn't exist, and a wrong password were indistinguishable — including from
  // a misconfigured AUTH_SECRET, which also surfaces as an AuthError.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { password: true },
  })
  if (!user) return { error: `No account exists for ${email}. Sign up instead.` }
  if (!user.password) return { error: "That account has no password set." }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/protected",
    })
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.type === "CredentialsSignin") return { error: "Wrong password." }
      return { error: `Sign-in failed (${error.type}). This isn't your password.` }
    }
    throw error
  }
}
