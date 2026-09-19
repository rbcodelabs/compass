"use client"

import { useEffect, useState, useTransition } from "react"
import { signIn } from "next-auth/webauthn"
import { Button } from "@/components/ui/button"

/**
 * Sign-in-only passkey button for /login. The WebAuthn ceremony
 * (navigator.credentials.get()) must run in the browser, so this can't be a
 * server action like the Google/magic-link forms next to it.
 *
 * Feature-detected via `window.PublicKeyCredential`: browsers without
 * WebAuthn support (or non-browser environments during SSR) never render
 * the button rather than offering a control that would only fail on click.
 */
export function PasskeyLoginButton() {
  const [supported, setSupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "PublicKeyCredential" in window)
  }, [])

  if (!supported) return null

  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="h-11 w-full font-semibold"
        disabled={pending}
        onClick={() => {
          setError(null)
          startTransition(async () => {
            try {
              await signIn("passkey", { callbackUrl: "/dashboard" })
            } catch (e) {
              setError(e instanceof Error ? e.message : "Passkey sign-in failed")
            }
          })
        }}
      >
        Sign in with a passkey
      </Button>
    </div>
  )
}
