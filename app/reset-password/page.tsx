import { Suspense } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ResetForm } from "./form"

// Reading searchParams is uncached, and this route sits outside the
// (authenticated) group so it has no Suspense boundary above it — with cache
// components on, prerendering the root layout's SessionProvider fails without
// one. Same wrapper the authenticated layout uses.
async function TokenGate({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams

  if (!token) {
    return (
      <p className="text-sm text-muted-foreground">
        This link is missing its token. Ask for a fresh reset link.
      </p>
    )
  }

  return (
    <>
      <p className="text-sm text-muted-foreground mb-4">
        Pick a password for your account. This link works once.
      </p>
      <ResetForm token={token} />
    </>
  )
}

export default function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set a password</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
            <TokenGate searchParams={searchParams} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  )
}
