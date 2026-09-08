import { auth } from "@/auth"

// "Public" here means the session cookie isn't required — every one of these
// API routes still checks a bearer token of its own.
// /api/media covers the token-authed confirm/reject links at /api/media/verify
const publicRoutes = ["/", "/sign-in", "/sign-up", "/reset-password", "/api/auth", "/api/agent/cron", "/api/agent/approve", "/podcast-tools", "/api/quote-card", "/api/cron", "/api/content", "/api/media", "/api/riverside/identify", "/api/profiles", "/api/admin", "/api/inbound"]
const ALLOWED_EMAILS = ["gigi@slow.co"]

export default auth((req) => {
  const { pathname } = req.nextUrl
  const isPublic = publicRoutes.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  )

  if (!req.auth && !isPublic) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin)
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.href)
    return Response.redirect(signInUrl)
  }

  // If logged in but not on the allowlist, redirect to sign-in.
  // Compared lowercased: sign-up doesn't normalise the address, so an account
  // created as "Gigi@slow.co" authenticated fine and then got bounced straight
  // back here, which is indistinguishable from a wrong password.
  const email = (req.auth?.user?.email ?? "").toLowerCase()
  if (req.auth && !isPublic && !ALLOWED_EMAILS.includes(email)) {
    return Response.redirect(new URL("/sign-in", req.nextUrl.origin))
  }
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
