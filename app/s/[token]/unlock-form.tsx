"use client"

import { useActionState } from "react"
import { unlockShareAction, type UnlockFormState } from "./actions"

export function UnlockForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<UnlockFormState, FormData>(unlockShareAction, { error: null })
  return (
    <form action={action} className="mt-6 space-y-3">
      <input type="hidden" name="token" value={token} />
      <label htmlFor="share-password" className="block text-sm font-medium">Password</label>
      <input
        id="share-password"
        name="password"
        type="password"
        autoComplete="off"
        autoFocus
        required
        maxLength={200}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {pending ? "Checking…" : "View"}
      </button>
    </form>
  )
}
