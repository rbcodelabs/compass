/**
 * The two discovery documents, and the four URLs they are served at.
 *
 * Both are **pure config**: no database, no request context, nothing async.
 * That is a hard requirement, not a style preference — Claude enforces a 10 s
 * timeout on discovery, and a cold Vercel function plus a DSQL IAM-signed
 * connection can approach it on its own (see "Latency risk" in
 * docs/design/mcp-oauth-discovery.md). There is also nothing to query: every
 * value below is derived from the deployment origin.
 *
 * Two rules govern what goes in these objects:
 *
 *  1. **Omit unsupported keys; never null them.** Claude Code Zod-fails on a
 *     `"registration_endpoint": null` (anthropics/claude-code#38102), so a
 *     nulled key is strictly worse than an absent one.
 *  2. **Advertise only what is implemented.** The inverse of (1) and the more
 *     dangerous direction: `authorization_response_iss_parameter_supported`
 *     and `code_challenge_methods_supported` both make clients change
 *     behaviour, and `client_id_metadata_document_supported` would make Claude
 *     attempt a flow this server does not have instead of falling back to DCR.
 */
import {
  RESOURCE_SCOPES,
  SUPPORTED_SCOPES,
  mcpResourceUri,
  oauthIssuer,
} from "@/lib/oauth/constants"
import { SUPPORTED_CODE_CHALLENGE_METHODS } from "@/lib/oauth/pkce"

/** Paths of the authorization server's own endpoints, relative to the issuer. */
export const AUTHORIZATION_ENDPOINT_PATH = "/oauth/authorize"
export const TOKEN_ENDPOINT_PATH = "/api/oauth/token"
export const REGISTRATION_ENDPOINT_PATH = "/api/oauth/register"
export const REVOCATION_ENDPOINT_PATH = "/api/oauth/revoke"

/**
 * RFC 9728 §3.1 path insertion for a resource at `/api/mcp`. The MCP SDK's
 * client-side discovery derives exactly this URL from the resource URL, and the
 * Geode broker discovers from the resource URL, so this path — not the bare
 * root one — is the mandatory half of the pair.
 */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/api/mcp"

/**
 * RFC 8414 §3 and OIDC Discovery. Clients MUST support both spellings and
 * different clients probe different ones first, so both are served, byte-identical.
 */
export const AUTHORIZATION_SERVER_METADATA_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
] as const

/**
 * RFC 8414 authorization server metadata.
 *
 * Not typed as a fixed interface on purpose: it is a JSON document whose shape
 * is defined by the registry, and pinning it to a local interface invites
 * someone to "fix" a mismatch by adding a key with a `null` value.
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  const issuer = oauthIssuer()
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZATION_ENDPOINT_PATH}`,
    token_endpoint: `${issuer}${TOKEN_ENDPOINT_PATH}`,
    registration_endpoint: `${issuer}${REGISTRATION_ENDPOINT_PATH}`,
    revocation_endpoint: `${issuer}${REVOCATION_ENDPOINT_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Load-bearing: "If code_challenge_methods_supported is absent, the
    // authorization server does not support PKCE and MCP clients MUST refuse to
    // proceed." Omitting this key breaks every client.
    code_challenge_methods_supported: [...SUPPORTED_CODE_CHALLENGE_METHODS],
    // "none" because every client here is public — Geode registers with it, and
    // a loopback client cannot hold a secret.
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    // RFC 9207. Implemented in app/oauth/authorize; advertising it without
    // emitting `iss` would be worse than not advertising it at all.
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...SUPPORTED_SCOPES],
    service_documentation: `${issuer}/help/09-mcp-api`,
    // `client_id_metadata_document_supported` is deliberately absent rather
    // than `false` — decision 5. See the module doc.
  }
}

/**
 * RFC 9728 protected resource metadata.
 *
 * `authorization_servers` is a spec-level MUST for MCP servers even though RFC
 * 9728 marks only `resource` required, and **Claude uses only the first entry
 * and does not fall back** — so the order of that array is load-bearing.
 *
 * `scopes_supported` here is {@link RESOURCE_SCOPES}, which omits
 * `offline_access`. That is not an oversight: the spec's "SHOULD NOT advertise
 * offline_access" guidance applies to this document, while the AS metadata
 * above must advertise it for Claude to request a refresh token.
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUri(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: [...RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Compass",
    resource_documentation: `${oauthIssuer()}/help/09-mcp-api`,
  }
}
