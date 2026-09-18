/**
 * Issuer, canonical resource URI, and scope vocabulary for Compass's OAuth
 * authorization server.
 *
 * Framework-free and DB-free on purpose: the `.well-known` documents that will
 * consume these have a hard 10 s client timeout (see
 * docs/design/mcp-oauth-discovery.md, "Latency risk"), so nothing in this
 * module may reach for a database or a request context.
 */
import { trustedCompassBaseUrl } from "@/lib/compass-url"

/** Read-only MCP tool access. */
export const SCOPE_MCP_READ = "mcp:read"
/** Mutating MCP tool access. */
export const SCOPE_MCP_WRITE = "mcp:write"
/**
 * Advertised so clients that gate refresh-token requests on it (Claude) ask
 * for one. Compass issues a refresh token for every authorization-code grant
 * regardless — the Geode broker never requests this scope and still depends on
 * refresh to recover from an upstream 401.
 */
export const SCOPE_OFFLINE_ACCESS = "offline_access"

/**
 * `scopes_supported` for the **authorization server** metadata document.
 *
 * Deliberately short: a client that receives no `scope` parameter in the 401
 * challenge requests everything listed here, so each extra entry is consent
 * surface granted by default.
 */
export const SUPPORTED_SCOPES = [SCOPE_MCP_READ, SCOPE_MCP_WRITE, SCOPE_OFFLINE_ACCESS] as const

/**
 * `scopes_supported` for the **protected resource** metadata document. A
 * different file from the AS metadata, and the spec's "SHOULD NOT advertise
 * offline_access" guidance applies to this one only — hence the split.
 */
export const RESOURCE_SCOPES = [SCOPE_MCP_READ, SCOPE_MCP_WRITE] as const

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number]

export function isSupportedScope(scope: string): scope is SupportedScope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(scope)
}

/**
 * Splits an OAuth `scope` string on ASCII whitespace (RFC 6749 §3.3 makes it a
 * space-delimited list) and de-duplicates while preserving first-seen order.
 */
export function parseScope(raw: string | null | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/\s+/).filter((entry) => entry.length > 0))]
}

/** Inverse of `parseScope`, de-duplicating so round-tripping is stable. */
export function formatScope(scopes: readonly string[]): string {
  return [...new Set(scopes.filter((entry) => entry.length > 0))].join(" ")
}

/** The subset of a requested scope string Compass is willing to grant. */
export function filterSupportedScopes(raw: string | null | undefined): SupportedScope[] {
  return parseScope(raw).filter(isSupportedScope)
}

/**
 * The OAuth issuer identifier: origin only, no path, no trailing slash.
 *
 * Clients **MUST** byte-compare the `issuer` in the metadata document against
 * the issuer they derived the URL from, so this value cannot drift between the
 * document and the URL it was served at. `trustedCompassBaseUrl()` already
 * resolves preview deploys via `VERCEL_BRANCH_URL`, which is stable per branch
 * (unlike `VERCEL_URL`, which changes per deployment).
 */
export function oauthIssuer(): string {
  return assertCanonical(trustedCompassBaseUrl().origin)
}

/**
 * The canonical resource URI this authorization server mints tokens for —
 * the RFC 8707 audience, and the `resource` field of the protected-resource
 * metadata document.
 *
 * Must equal the MCP endpoint URL exactly as a user types it: HTTPS, no
 * fragment, no trailing slash.
 */
export function mcpResourceUri(): string {
  return assertCanonical(new URL("/api/mcp", trustedCompassBaseUrl()).toString())
}

/**
 * Guards the two shape rules the spec puts on both identifiers. HTTP is
 * tolerated only on loopback, matching the local-development carve-out
 * `lib/compass-url.ts` already makes for `NEXT_PUBLIC_APP_URL`.
 */
function assertCanonical(value: string): string {
  const url = new URL(value)
  if (url.hash) throw new Error("OAuth identifiers must not contain a fragment.")
  if (value.endsWith("/")) throw new Error("OAuth identifiers must not have a trailing slash.")
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("OAuth identifiers must use HTTPS (except local development).")
  }
  return value
}
