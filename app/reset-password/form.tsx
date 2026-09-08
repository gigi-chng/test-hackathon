"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { completePasswordReset } from "@/lib/actions/password-reset"

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<{ error?: string }, FormData>(
    async (_prev, formData) => (await completePasswordReset(formData)) ?? {},
    {}
  )

  return (
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
  )
}
