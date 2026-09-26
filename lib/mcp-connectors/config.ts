/**
 * The catalog of third-party MCP servers Compass knows how to connect to, and
 * the error type shared by every module in this directory (ADR-0018).
 *
 * The catalog is **code, not data**. A connector is not a row a user creates —
 * adding one means Compass will mint an OAuth client against somebody else's
 * authorization server and then proxy the cloud agent's traffic through it, so
 * the set of reachable hosts belongs in a reviewed diff. `mcp_connectors` rows
 * are *derived*: one per (slug, origin) pair, holding the discovered endpoints
 * and the `client_id` that origin's Dynamic Client Registration produced.
 *
 * `serverUrl` is the only value here that is trusted as an input to `fetch`.
 * Everything downstream of it — the `resource_metadata` pointer, the
 * authorization server's endpoints — arrives from the network and is validated
 * in discovery.ts before it is used.
 */

export interface ConnectorDefinition {
  /** Stable, URL-safe. Appears in the gateway path `/api/integrations/mcp/<slug>`. */
  slug: string
  displayName: string
  /** The MCP endpoint itself. Must be HTTPS; its origin bounds discovery. */
  serverUrl: string
  /**
   * Used only when neither metadata document advertises a scope. v0's
   * protected-resource document reports `scopes_supported: null` while its
   * authorization server advertises `["mcp"]`, so in practice the AS document
   * supplies it and this is a last resort rather than the normal path.
   */
  fallbackScope: string
  /**
   * Appended to the cloud agent's system prompt when this connector is enabled
   * for the turn, and only then.
   *
   * Tool *descriptions* come from the provider and cannot be edited; what a
   * provider never states is how its tools behave inside Compass's constraints.
   * The gateway aborts a single proxied call at `GATEWAY_TIMEOUT_MS`, so a
   * provider tool that blocks for minutes is unusable through it even though the
   * provider considers it perfectly normal — the agent has to be told to reach
   * for that provider's non-blocking path instead. Guidance therefore belongs
   * next to the `serverUrl` it applies to, not in the generic system prompt,
   * which knows nothing about which connectors this user holds.
   */
  agentGuidance?: string
}

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    slug: "v0",
    displayName: "v0",
    serverUrl: "https://v0.app/api/mcp",
    fallbackScope: "mcp",
    // Verified against the live catalog on 2026-09-25: `createChat` takes
    // `responseMode: "sync" | "async"`, and `getChat` fetches one chat by id.
    // Synchronous generation of anything non-trivial runs well past the
    // gateway's ceiling — the first real turn spent 55 s on one `createChat`
    // and was aborted, *after* v0 had already built the app. Async plus
    // polling is the only shape that both fits the ceiling and stops the agent
    // reporting completed work as a failure.
    agentGuidance: [
      "v0 generation is slow enough that a synchronous call will be cut off before it finishes.",
      'Always pass responseMode: "async" to mcp__v0__createChat. It returns immediately with a chat id.',
      "Then poll mcp__v0__getChat with that id, waiting a few seconds between polls, until the chat reports",
      "its generated files or a demo/preview URL. Report the chat's URL to the user when it is ready.",
      "If any v0 call reports a timeout, the work may still have completed: call mcp__v0__findChats or",
      "mcp__v0__getChat to check before creating anything a second time, and never tell the user to rebuild",
      "something by hand without checking first.",
    ].join(" "),
  },
]

export function connectorDefinition(slug: string): ConnectorDefinition | null {
  return CONNECTOR_DEFINITIONS.find(definition => definition.slug === slug) ?? null
}

/**
 * The OAuth `redirect_uri` for one connector at one Compass origin.
 *
 * Built in exactly one place because the authorization server matches it by
 * **exact string**: the value registered via DCR, the value on the authorization
 * request, and the value on the code exchange must all be byte-identical, and
 * `origin` must come from `trustedCompassBaseUrl()` rather than a request header.
 */
export function connectorRedirectUri(slug: string, origin: string): string {
  return new URL(`/api/connectors/${encodeURIComponent(slug)}/callback`, origin).toString()
}

/**
 * Where the connect flow lands when no `returnTo` was supplied.
 *
 * `/settings/agents` already hosts `ConnectedAppsPanel` — the *inbound*
 * direction, third-party apps connected to Compass — so the outbound connector
 * list belongs on the same page.
 */
export const DEFAULT_CONNECTOR_RETURN_PATH = "/settings/agents"

export type McpConnectorErrorCode =
  | "UNKNOWN_CONNECTOR"
  | "ENCRYPTION_NOT_CONFIGURED"
  | "DISCOVERY_FAILED"
  | "REGISTRATION_FAILED"
  | "NOT_CONNECTED"
  | "GRANT_CHANGED"
  | "TOKEN_EXCHANGE_FAILED"
  | "REFRESH_FAILED"
  | "INVALID_AUTH_REQUEST"
  /** The proxied MCP call itself failed — distinct from a failure to obtain a token. */
  | "GATEWAY_FAILED"
  /**
   * The proxied call ran past `GATEWAY_TIMEOUT_MS` and Compass abandoned it.
   *
   * Separate from `GATEWAY_FAILED` because the two want opposite advice. A
   * failure means nothing happened; a timeout means Compass stopped listening
   * and the provider may well have finished the work. Collapsing them is what
   * produced an agent telling a user to rebuild an app v0 had already built.
   */
  | "GATEWAY_TIMEOUT"

export class McpConnectorError extends Error {
  readonly code: McpConnectorErrorCode

  constructor(code: McpConnectorErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = "McpConnectorError"
  }
}

/**
 * The AES-256-GCM key that protects stored third-party access and refresh
 * tokens.
 *
 * Deliberately a *different* variable from `ANALYTICS_SECRET_ENCRYPTION_KEY`.
 * These two ciphertext populations have different blast radii — an analytics
 * token reads one project's metrics; a connector grant acts as a Compass user
 * inside a third-party product — so they should be rotatable independently, and
 * a single shared key would make rotating either one a coordinated migration of
 * both.
 */
export function connectorEncryptionKey(): string {
  const key = process.env.MCP_CONNECTOR_SECRET_ENCRYPTION_KEY
  if (!key)
    throw new McpConnectorError(
      "ENCRYPTION_NOT_CONFIGURED",
      "MCP_CONNECTOR_SECRET_ENCRYPTION_KEY is not set; connector tokens cannot be stored or read.",
    )
  return key
}

/** How long an authorization request (state + PKCE verifier) stays usable. */
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000

/**
 * Refresh this many seconds before the provider's stated expiry.
 *
 * There is no proactive refresh timer anywhere in this feature — a serverless
 * invocation does not outlive the request that created it, and Agent Threads'
 * timer-based implementation has a documented zero-delay spin when
 * `expires_in <= 300`. Refresh happens lazily, on the request that needs a
 * token, which is the only moment the answer matters.
 */
export const REFRESH_SKEW_SECONDS = 60

/** Bounds every outbound call to a third-party OAuth or metadata endpoint. */
export const OUTBOUND_TIMEOUT_MS = 10_000
