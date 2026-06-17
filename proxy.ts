import { auth } from "@/auth"

const publicRoutes = ["/", "/sign-in", "/sign-up", "/api/auth", "/api/agent/telegram", "/api/agent/cron", "/api/agent/approve", "/podcast-tools", "/api/quote-card", "/api/cron", "/api/content", "/api/profiles"]
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

  // If logged in but not on the allowlist, redirect to sign-in
  if (req.auth && !isPublic && !ALLOWED_EMAILS.includes(req.auth.user?.email ?? "")) {
    return Response.redirect(new URL("/sign-in", req.nextUrl.origin))
  }
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
