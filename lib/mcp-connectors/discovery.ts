/**
 * Outbound OAuth discovery and Dynamic Client Registration (ADR-0018).
 *
 * ## The pointer, not the derived path
 *
 * RFC 9728 §3.1 describes a path-inserted well-known URL
 * (`https://host/.well-known/oauth-protected-resource/api/mcp` for a resource at
 * `https://host/api/mcp`). **Do not derive it.** v0 serves its document at the
 * *root* form instead, and its 401 challenge says so explicitly:
 *
 *   www-authenticate: Bearer resource_metadata="https://v0.app/.well-known/oauth-protected-resource"
 *
 * Deriving the path-inserted form against v0 returns 404, which reads as "this
 * server doesn't do OAuth" rather than "we guessed the URL". So the challenge is
 * the only source: no challenge header, no discovery, and a loud error.
 *
 * ## What is trusted
 *
 * Only `ConnectorDefinition.serverUrl` — it comes from a reviewed diff. The
 * `resource_metadata` pointer, the `resource` identifier, and the authorization
 * server list all arrive over the network, so each is validated before it is
 * used as a fetch target or written to the database:
 *
 *  - the pointer must be HTTPS and **same-origin as `serverUrl`**, because RFC
 *    9728 has the resource server publish its own document. Without that check a
 *    single compromised response redirects Compass's metadata fetch — and then
 *    its users' authorization flow — to an arbitrary host.
 *  - `resource` must be HTTPS and same-origin too; it is the RFC 8707 audience
 *    Compass will bind every token to.
 *  - the authorization server's `issuer` must byte-match the URL we asked about
 *    (RFC 8414 §3.3), which is the check that makes metadata mix-up attacks fail.
 */
import { McpConnectorError, type ConnectorDefinition } from "@/lib/mcp-connectors/config"
import { fetchJsonObject, outboundFetch, requireHttpsUrl } from "@/lib/mcp-connectors/http"

export interface DiscoveredConnector {
  /** RFC 8707 audience. Sent identically on authorize, exchange, and refresh. */
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string | null
  registrationEndpoint: string | null
  /** Space-delimited, as it appears in an authorization request. */
  scope: string
}

export async function discoverConnector(definition: ConnectorDefinition): Promise<DiscoveredConnector> {
  const serverUrl = https(definition.serverUrl, "serverUrl")
  const pointer = await fetchResourceMetadataPointer(serverUrl)
  requireSameOrigin(pointer, serverUrl, "resource_metadata pointer")

  const resourceDocument = await fetchJsonObject(pointer, { method: "GET" }, "DISCOVERY_FAILED")
  const resource = https(stringField(resourceDocument, "resource"), "resource")
  requireSameOrigin(resource, serverUrl, "resource")

  const issuers = optionalStringArray(resourceDocument.authorization_servers) ?? []
  if (!issuers.length)
    throw new McpConnectorError(
      "DISCOVERY_FAILED",
      `${pointer.toString()} lists no authorization_servers.`,
    )
  const issuer = https(issuers[0], "authorization_servers[0]")

  const asDocument = await fetchAuthorizationServerMetadata(issuer)

  return {
    resource: resource.toString(),
    authorizationEndpoint: https(
      stringField(asDocument, "authorization_endpoint"),
      "authorization_endpoint",
    ).toString(),
    tokenEndpoint: https(stringField(asDocument, "token_endpoint"), "token_endpoint").toString(),
    revocationEndpoint: optionalHttps(asDocument.revocation_endpoint, "revocation_endpoint"),
    registrationEndpoint: optionalHttps(asDocument.registration_endpoint, "registration_endpoint"),
    scope: resolveScope(definition, resourceDocument, asDocument),
  }
}

/**
 * Reads the `resource_metadata` pointer out of the 401 challenge.
 *
 * An `initialize` call is used rather than a bare GET because that is what a
 * real MCP client sends, and some servers answer anything else with a 405 that
 * carries no challenge at all. A 2xx that still carries no challenge is treated
 * the same as any other missing challenge: an MCP endpoint that serves an
 * unauthenticated request needs no connector, and building an OAuth flow around
 * a server that never asked for one would be inventing a requirement.
 */
async function fetchResourceMetadataPointer(serverUrl: URL): Promise<URL> {
  const response = await outboundFetch(
    serverUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "compass", version: "1" },
        },
      }),
    },
    "DISCOVERY_FAILED",
  )
  const challenge = response.headers.get("www-authenticate")
  if (!challenge)
    throw new McpConnectorError(
      "DISCOVERY_FAILED",
      `${serverUrl.toString()} answered ${response.status} with no WWW-Authenticate challenge, so its protected-resource metadata URL is unknown. Compass will not guess it.`,
    )
  // RFC 9728 §5.1. Matched case-insensitively on the parameter name only; the
  // value is a quoted-string and is taken verbatim.
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge)
  if (!match)
    throw new McpConnectorError(
      "DISCOVERY_FAILED",
      `The WWW-Authenticate challenge from ${serverUrl.toString()} carries no resource_metadata parameter.`,
    )
  return https(match[1], "resource_metadata")
}

/**
 * RFC 8414 §3.1 path insertion, then the OpenID Connect layout as a fallback.
 *
 * Order matters: the path-inserted OAuth form is the one the RFC mandates, and
 * trying `openid-configuration` first would pick up an identity-provider
 * document from a server that also happens to be an OP, whose `token_endpoint`
 * may not accept the MCP resource at all.
 */
async function fetchAuthorizationServerMetadata(issuer: URL): Promise<Record<string, unknown>> {
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "")
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuer),
    new URL(`/.well-known/openid-configuration${issuerPath}`, issuer),
  ]

  const failures: string[] = []
  for (const candidate of candidates) {
    let document: Record<string, unknown>
    try {
      document = await fetchJsonObject(candidate, { method: "GET" }, "DISCOVERY_FAILED")
    } catch (error) {
      failures.push(`${candidate.toString()}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    // RFC 8414 §3.3: the issuer in the document MUST match the one requested.
    // Byte comparison after dropping at most one trailing slash, because servers
    // differ on whether they include it and that difference is not a change of
    // identity. A *mismatch* is fatal rather than a reason to try the next
    // candidate — it means this host is serving somebody else's metadata, which
    // is the mix-up attack, not a layout difference.
    const advertised = stringField(document, "issuer")
    if (trimSlash(advertised) !== trimSlash(issuer.toString()))
      throw new McpConnectorError(
        "DISCOVERY_FAILED",
        `${candidate.toString()} advertises issuer ${advertised}, which does not match ${issuer.toString()}.`,
      )
    return document
  }
  throw new McpConnectorError(
    "DISCOVERY_FAILED",
    `No authorization server metadata found for ${issuer.toString()} (${failures.join("; ")}).`,
  )
}

/**
 * Protected-resource metadata wins, then authorization-server metadata, then the
 * definition's fallback.
 *
 * The fallback chain is load-bearing rather than defensive: v0's resource
 * document reports `scopes_supported: null` while its authorization server
 * advertises `["mcp"]`, and requesting no scope at all is not equivalent —
 * providers differ on whether that means "everything" or "nothing".
 */
function resolveScope(
  definition: ConnectorDefinition,
  resourceDocument: Record<string, unknown>,
  asDocument: Record<string, unknown>,
): string {
  const scopes =
    optionalStringArray(resourceDocument.scopes_supported) ??
    optionalStringArray(asDocument.scopes_supported) ??
    [definition.fallbackScope]
  const scope = scopes.join(" ")
  // `mcp_connectors.scope` is VARCHAR(255); a provider advertising more scopes
  // than that must be narrowed deliberately in its definition, not truncated
  // here into a request that asks for half a scope name.
  if (!scope || scope.length > 255)
    throw new McpConnectorError(
      "DISCOVERY_FAILED",
      `${definition.slug} advertises an unusable scope set (${scope.length} characters).`,
    )
  return scope
}

/**
 * Registers Compass as a **public** client for one redirect URI (RFC 7591).
 *
 * One registration per (connector, origin). `redirect_uri` is matched by exact
 * string at the authorization server, so every preview origin needs its own
 * `client_id` — there is no wildcard, and rebuilding the URI from request
 * headers at callback time would be both attacker-influenced and a mismatch.
 *
 * A returned `client_secret` is a hard failure, not something to store. ADR-0018
 * deliberately has no encrypted client-secret column: v0 issues a public client
 * (verified live — `token_endpoint_auth_method: "none"` is echoed back and no
 * secret is returned), so PKCE alone carries the exchange. A provider that
 * insists on a confidential client is a schema change plus a review, and should
 * say so loudly rather than half-work.
 */
export async function registerConnectorClient(input: {
  registrationEndpoint: string
  redirectUri: string
  clientName: string
  scope: string
}): Promise<string> {
  const endpoint = requireHttpsUrl(input.registrationEndpoint, "registration_endpoint", "REGISTRATION_FAILED")
  const document = await fetchJsonObject(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: input.scope,
      }),
    },
    "REGISTRATION_FAILED",
  )

  if (typeof document.client_secret === "string" && document.client_secret)
    throw new McpConnectorError(
      "REGISTRATION_FAILED",
      `${endpoint.toString()} issued a confidential client. ADR-0018 supports public clients only — storing a client secret needs a schema change and a review.`,
    )

  const clientId = document.client_id
  if (typeof clientId !== "string" || !clientId || clientId.length > 255)
    throw new McpConnectorError(
      "REGISTRATION_FAILED",
      `${endpoint.toString()} returned no usable client_id.`,
    )
  return clientId
}

// ── Validation helpers ──────────────────────────────────────────────────────

function https(raw: string, label: string): URL {
  return requireHttpsUrl(raw, label, "DISCOVERY_FAILED")
}

function optionalHttps(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !value) return null
  return https(value, label).toString()
}

function requireSameOrigin(url: URL, expected: URL, label: string): void {
  if (url.origin !== expected.origin)
    throw new McpConnectorError(
      "DISCOVERY_FAILED",
      `${label} points at ${url.origin}, which is not the MCP server's origin ${expected.origin}.`,
    )
}

function stringField(document: Record<string, unknown>, key: string): string {
  const value = document[key]
  if (typeof value !== "string" || !value)
    throw new McpConnectorError("DISCOVERY_FAILED", `Metadata is missing "${key}".`)
  return value
}

/** `null` means "not advertised" — distinct from an advertised empty list. */
function optionalStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return strings.length ? strings : null
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}
