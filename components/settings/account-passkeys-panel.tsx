"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { signIn } from "next-auth/webauthn"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/patterns/settings-section"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export type PasskeyRow = {
  id: string
  credentialDeviceType: string
  credentialBackedUp: boolean
  createdAt: string
}

function formatDate(iso: string) {
  return new Date(iso).toISOString().slice(0, 10)
}

export function AccountPasskeysPanel({
  enabled,
  authenticators,
}: {
  enabled: boolean
  authenticators: PasskeyRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  function addPasskey() {
    setError(null)
    startTransition(async () => {
      try {
        await signIn("passkey", { action: "register" })
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not register passkey")
      }
    })
  }

  function revoke(id: string) {
    setError(null)
    startTransition(async () => {
      try {
        const response = await fetch(`/api/webauthn/authenticators/${id}`, { method: "DELETE" })
        if (!response.ok) throw new Error("Could not revoke passkey")
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not revoke passkey")
      } finally {
        setPendingDeleteId(null)
      }
    })
  }

  return (
    <SettingsSection
      title="Passkeys"
      description="Sign in without a password using a passkey stored on this device or synced across your devices."
      actions={enabled && (
        <Button type="button" onClick={addPasskey} disabled={pending}>
          Add a passkey
        </Button>
      )}
    >
      <div className="space-y-4">
        {!enabled && (
          <p className="text-sm text-text-muted">
            Passkey login is currently disabled. Existing passkeys remain visible; you can still revoke them.
          </p>
        )}
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        {!authenticators.length && <p className="text-sm text-text-muted">No passkeys registered yet.</p>}
        <ul className="space-y-2">
          {authenticators.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-default p-2 text-sm"
            >
              <span>
                {a.credentialDeviceType} · {a.credentialBackedUp ? "Backed up" : "Not backed up"}
                <span className="block text-xs text-text-muted">Added {formatDate(a.createdAt)}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setPendingDeleteId(a.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <AlertDialog open={pendingDeleteId !== null} onOpenChange={(open) => !open && setPendingDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              You will no longer be able to sign in with this passkey. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => pendingDeleteId && revoke(pendingDeleteId)}
            >
              Revoke passkey
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}
