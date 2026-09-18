/**
 * The resource server's half of the OAuth handshake: the `WWW-Authenticate`
 * challenge, and the scope a given MCP request requires.
 *
 * ## Why this is hand-rolled rather than `mcp-handler`'s `withMcpAuth`
 *
 * `mcp-handler@1.1.0` ships a `withMcpAuth` wrapper, and it gets three things
 * wrong for this endpoint — each independently disqualifying:
 *
 *  1. **`required` defaults to `false`.** If `verifyToken` returns `undefined`
 *     the request is passed through **unauthenticated**. A wrapper whose
 *     failure mode is "serve the request anyway" is the wrong shape for an
 *     auth boundary regardless of what you pass it.
 *  2. **`resourceMetadataPath` defaults to the root path** and performs no RFC
 *     9728 §3.1 path insertion. For a resource at `/api/mcp` the correct value
 *     is `/.well-known/oauth-protected-resource/api/mcp`, which is also the URL
 *     the MCP SDK's client-side discovery derives — so the default sends every
 *     discovering client to the wrong document.
 *  3. **It never emits the `scope` parameter**, even when `requiredScopes` is
 *     set. Per Anthropic's connector documentation a client that receives no
 *     `scope` requests *everything* in `scopes_supported` — maximal consent on
 *     every connection. Emitting `scope` is the entire reason this file exists.
 *
 * ## 401 vs 403
 *
 * A missing or unusable token is **401** with `resource_metadata` and
 * `scope="mcp:read"`, which is what starts discovery. A token that is valid but
 * insufficiently scoped is **403** with `error="insufficient_scope"` and the
 * scope that would have worked — re-authenticating would not help, so a 401
 * would send the client round a loop it cannot win.
 *
 * Both must be real HTTP statuses. Claude ignores `WWW-Authenticate` on a 200,
 * so the JSON-RPC-shaped "error result with status 200" that MCP uses for tool
 * failures is not available here.
 */
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE, mcpResourceUri, oauthIssuer } from "@/lib/oauth/constants"
import { PROTECTED_RESOURCE_METADATA_PATH } from "@/lib/oauth/metadata"
import { type ToolScope, requiredToolScope } from "@/lib/mcp-tool-gates"

/**
 * The absolute URL of this resource's metadata document, or `null` when the
 * deployment cannot resolve its own origin.
 *
 * Null is a real case, not a defensive nicety: `trustedCompassBaseUrl()` throws
 * `CompassUrlNotConfiguredError` on a production deployment missing
 * `NEXT_PUBLIC_APP_URL`. The MCP endpoint must still answer 401 there — it just
 * answers with a bare `Bearer` challenge, exactly as it did before OAuth
 * existed, rather than failing the request with a 500.
 */
export function protectedResourceMetadataUrl(): string | null {
  try {
    return `${oauthIssuer()}${PROTECTED_RESOURCE_METADATA_PATH}`
  } catch {
    return null
  }
}

/** The canonical audience, or `null` when the origin is unresolvable. */
export function mcpResourceUriOrNull(): string | null {
  try {
    return mcpResourceUri()
  } catch {
    return null
  }
}

export interface BearerChallengeInput {
  /** RFC 6750 §3 error code. Omitted for a plain "authenticate first" 401. */
  error?: "insufficient_scope"
  errorDescription?: string
  /** The scope that would satisfy this request. */
  scope?: string
}

/**
 * An RFC 6750 `WWW-Authenticate: Bearer …` value with RFC 9728's
 * `resource_metadata` parameter.
 *
 * Parameter values are quoted-string per RFC 9110 §11.2. Everything
 * interpolated here is server-controlled (a scope constant, or a URL built from
 * the deployment origin), but `"` and `\` are escaped anyway so a misconfigured
 * origin can never break out of the quoting and forge a second parameter.
 */
export function bearerChallenge(input: BearerChallengeInput = {}): string {
  const parts: string[] = []
  if (input.error) parts.push(param("error", input.error))
  if (input.errorDescription) parts.push(param("error_description", input.errorDescription))
  if (input.scope) parts.push(param("scope", input.scope))
  const metadata = protectedResourceMetadataUrl()
  if (metadata) parts.push(param("resource_metadata", metadata))
  return parts.length ? `Bearer ${parts.join(", ")}` : "Bearer"
}

function param(name: string, value: string): string {
  return `${name}="${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/**
 * The scope an MCP payload requires.
 *
 * Only `tools/call` can be a write; `initialize`, `tools/list`, `ping`,
 * notifications and everything else are reads. A batch takes the strongest
 * requirement of its members, because the transport will execute all of them.
 *
 * Fail-closed in the one ambiguous case: a `tools/call` whose `name` is absent
 * or not a string requires `mcp:write`. It is a malformed request that the
 * handler will reject anyway, and guessing "read" would be the guess that
 * matters if it were ever wrong.
 */
export function requiredScopeForPayload(payload: unknown): ToolScope {
  const messages = Array.isArray(payload) ? payload : [payload]
  for (const message of messages) {
    if (!isJsonRpcObject(message) || message.method !== "tools/call") continue
    const name = (message.params as { name?: unknown } | undefined)?.name
    const scope = typeof name === "string" ? requiredToolScope(name) : SCOPE_MCP_WRITE
    if (scope === SCOPE_MCP_WRITE) return SCOPE_MCP_WRITE
  }
  return SCOPE_MCP_READ
}

function isJsonRpcObject(value: unknown): value is { method?: unknown; params?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
