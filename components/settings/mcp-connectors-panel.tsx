"use client"

/**
 * The outbound half of this page (ADR-0018).
 *
 * `ConnectedAppsPanel` directly above lists apps connected **to** Compass. This
 * lists servers Compass connects **to** on the user's behalf — the opposite
 * direction, which is why it is a separate panel rather than more rows in that
 * one. Confusing the two would mean offering "Revoke" on a grant that lives at a
 * third party.
 *
 * Connect is a plain link, not a fetch: the flow's first step is a 302 to
 * somebody else's authorization server, and a browser has to follow it with the
 * user watching. Disconnect is a fetch, because its only product is a state
 * change on this page.
 */

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { SettingsSection } from "@/components/patterns/settings-section"
import { cn } from "@/lib/utils"

export interface McpConnectorView {
  slug: string
  displayName: string
  serverUrl: string
  connected: boolean
}

/**
 * Codes the callback route puts in the URL, rendered for a human.
 *
 * The callback deliberately never forwards a provider's error text — it can quote
 * a response body — so the code is all there is to work from. Anything unmapped
 * falls through to the code itself rather than a generic message, because a code
 * we have not seen before is exactly what someone reporting a bug needs to quote.
 */
const ERROR_MESSAGES: Record<string, string> = {
  WRONG_USER: "That authorization was started from a different Compass account. Start the connection again from this page.",
  CONNECTOR_MISMATCH: "That authorization did not match this connector. Start the connection again.",
  INVALID_AUTH_REQUEST: "The connection request expired or was already used. Start it again.",
  MISSING_PARAMETERS: "The provider's response was incomplete. Start the connection again.",
  AUTHORIZATION_FAILED: "The provider declined the authorization.",
  access_denied: "You declined the authorization at the provider.",
  TOKEN_EXCHANGE_FAILED: "Compass could not exchange the authorization code for a token. Try again.",
  REGISTRATION_FAILED: "Compass could not register itself as a client with the provider.",
  DISCOVERY_FAILED: "Compass could not read the provider's OAuth metadata.",
  ENCRYPTION_NOT_CONFIGURED: "Connector storage is not configured on this deployment.",
}

export function McpConnectorsPanel({
  connectors: initialConnectors,
  available,
  notice,
}: {
  connectors: McpConnectorView[]
  /** False when migration 062 has not been applied to this deployment's schema. */
  available: boolean
  notice: { slug: string; connected: boolean; error: string | null } | null
}) {
  const router = useRouter()
  const [connectors, setConnectors] = useState(initialConnectors)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const noticeName = notice ? connectors.find((item) => item.slug === notice.slug)?.displayName ?? notice.slug : null

  function disconnect(connector: McpConnectorView) {
    setError(null)
    setStatus(null)
    startTransition(async () => {
      try {
        const response = await fetch(`/api/connectors/${encodeURIComponent(connector.slug)}`, {
          method: "DELETE",
        })
        if (!response.ok) throw new Error(`Could not disconnect ${connector.displayName}.`)
        const body = (await response.json()) as { revokedAtProvider?: boolean }
        setConnectors((current) =>
          current.map((item) => (item.slug === connector.slug ? { ...item, connected: false } : item)),
        )
        // Stated rather than hidden: Compass always drops its own copy, but it
        // cannot always tell the provider, and the user may want to revoke at the
        // provider themselves.
        setStatus(
          body.revokedAtProvider
            ? `${connector.displayName} disconnected, and the token was revoked at ${connector.displayName}.`
            : `${connector.displayName} disconnected. Compass no longer holds a token; revoke Compass at ${connector.displayName} if you also want its own record removed.`,
        )
        router.refresh()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not update the connection")
      }
    })
  }

  return (
    <SettingsSection
      title="Connected MCP servers"
      description="Third-party MCP servers your Compass agent can call on your behalf. Compass holds the token; the agent's sandbox never sees it."
    >
      <div className="space-y-4">
        {!available && (
          <p role="status" className="text-sm text-text-muted">
            Connectors are not available on this deployment yet.
          </p>
        )}
        {notice?.connected && noticeName && (
          <p role="status" className="text-sm text-status-success">{noticeName} connected.</p>
        )}
        {notice?.error && (
          <p role="alert" className="text-sm text-status-danger">
            {ERROR_MESSAGES[notice.error] ?? `The connection failed (${notice.error}).`}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        {status && <p role="status" className="text-sm text-text-subtle">{status}</p>}
        {connectors.length === 0 && <p className="text-sm text-text-muted">No connectors are configured.</p>}
        {connectors.map((connector) => (
          <article
            key={connector.slug}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default p-4"
          >
            <div>
              <h3 className="font-medium text-text-primary">{connector.displayName}</h3>
              <p className="text-xs text-text-muted">{connector.serverUrl}</p>
              <p className="mt-1 text-xs text-text-muted">
                {connector.connected ? "Connected to your account." : "Not connected."}
              </p>
            </div>
            {connector.connected ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={pending}
                aria-label={`Disconnect ${connector.displayName}`}
                onClick={() => disconnect(connector)}
              >
                Disconnect
              </Button>
            ) : (
              // A real anchor, not a Button or a router push: the next hop is a
              // cross-origin 302 to the provider's authorization endpoint, which
              // the browser has to follow as a top-level navigation. Styled with
              // `buttonVariants` rather than wrapped in <Button> because this
              // Button has no `asChild`, and nesting a link inside it would
              // produce a button containing an anchor.
              <a
                href={`/api/connectors/${encodeURIComponent(connector.slug)}/connect?returnTo=${encodeURIComponent("/settings/agents")}`}
                aria-label={`Connect ${connector.displayName}`}
                aria-disabled={available ? undefined : true}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  available ? undefined : "pointer-events-none opacity-50",
                )}
              >
                Connect
              </a>
            )}
          </article>
        ))}
      </div>
    </SettingsSection>
  )
}
