"use client"

import { use, useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { completePasswordReset } from "@/lib/actions/password-reset"

export default function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = use(searchParams)
  const [state, action, pending] = useActionState<{ error?: string }, FormData>(
    async (_prev, formData) => (await completePasswordReset(formData)) ?? {},
    {}
  )

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set a password</CardTitle>
          <CardDescription>
            {token
              ? "Pick a password for gigi@slow.co. This link works once."
              : "This link is missing its token."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <form action={action} className="space-y-4">
              <input type="hidden" name="token" value={token} />
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input id="password" name="password" type="password" required minLength={6}
                  autoComplete="new-password" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm</Label>
                <Input id="confirm" name="confirm" type="password" required minLength={6}
                  autoComplete="new-password" />
              </div>
              {state.error && <p className="text-sm text-destructive">{state.error}</p>}
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? "Setting…" : "Set password and sign in"}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ask for a fresh reset link.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
