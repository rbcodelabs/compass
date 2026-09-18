/**
 * Registered OAuth clients: validation of a Dynamic Client Registration
 * request (RFC 7591), and lookup of the resulting row.
 *
 * Every client on this server is dynamically registered and unverified —
 * decision 4 rules out a static allowlist, and decision 2 keeps DCR open
 * because registration happens *before* any user is involved (the Geode broker
 * calls `registerClient()` and only then `authorize()`), so there is no session
 * to gate it on. Two things follow, and both live elsewhere but are the reason
 * this module is as strict as it is:
 *
 *  - The consent screen must mark every client unverified and show the redirect
 *    host, because `client_name` is attacker-chosen and "Compass Official" is
 *    as registrable as anything else.
 *  - `/register` is rate-limited per IP (lib/oauth/rate-limit.ts).
 *
 * What this module *can* do is refuse to register a redirect URI that could
 * become an open redirect for authorization codes, which is the one durable
 * consequence of a bad registration.
 */
import type { Prisma } from "@prisma/client"
import getPrisma from "@/lib/db"
import { SUPPORTED_SCOPES, filterSupportedScopes, formatScope } from "@/lib/oauth/constants"
import { isLoopbackRedirectUri } from "@/lib/oauth/redirect-uri"
import { hashOAuthToken, mintClientId, mintClientSecret } from "@/lib/oauth/tokens"

export const GRANT_AUTHORIZATION_CODE = "authorization_code"
export const GRANT_REFRESH_TOKEN = "refresh_token"
export const SUPPORTED_GRANT_TYPES = [GRANT_AUTHORIZATION_CODE, GRANT_REFRESH_TOKEN] as const

export const AUTH_METHOD_NONE = "none"
export const AUTH_METHOD_CLIENT_SECRET_POST = "client_secret_post"
export const SUPPORTED_AUTH_METHODS = [AUTH_METHOD_CLIENT_SECRET_POST, AUTH_METHOD_NONE] as const

/** Generous enough for any real client, bounded because registration is open. */
const MAX_REDIRECT_URIS = 10
const MAX_REDIRECT_URI_LENGTH = 2048
const MAX_CLIENT_NAME_LENGTH = 120
const MAX_URI_LENGTH = 2048

/** A client row, with the two `Json` columns already narrowed to `string[]`. */
export interface RegisteredClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  grantTypes: string[]
  scope: string
  tokenEndpointAuthMethod: string
  clientSecretHash: string | null
  clientUri: string | null
  logoUri: string | null
}

/**
 * Narrows a `Json` column to the string array it is supposed to hold.
 *
 * Defensive rather than paranoid: `redirect_uris` is JSONB, so a row written by
 * anything other than {@link validateRegistrationRequest} — a migration, a
 * hand-edit, a future code path — could hold any JSON at all, and a non-string
 * entry reaching `redirectUriMatches` would compare as `false` at best and
 * throw at worst.
 */
export function parseJsonStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
}

export async function findOAuthClient(clientId: string): Promise<RegisteredClient | null> {
  if (!clientId) return null
  const prisma = getPrisma()
  const row = await prisma.oAuthClient.findUnique({
    where: { clientId },
    select: {
      clientId: true,
      clientName: true,
      redirectUris: true,
      grantTypes: true,
      scope: true,
      tokenEndpointAuthMethod: true,
      clientSecretHash: true,
      clientUri: true,
      logoUri: true,
    },
  })
  if (!row) return null
  return {
    ...row,
    redirectUris: parseJsonStringArray(row.redirectUris),
    grantTypes: parseJsonStringArray(row.grantTypes),
  }
}

/**
 * Records that a client was used, best-effort.
 *
 * `lastUsedAt` is what TTL pruning keys off (phase 2), and a failure to stamp
 * it must never fail the request that was otherwise about to succeed — so this
 * swallows its own errors rather than being awaited into the critical path.
 */
export async function touchOAuthClient(clientId: string): Promise<void> {
  try {
    await getPrisma().oAuthClient.updateMany({
      where: { clientId },
      data: { lastUsedAt: new Date() },
    })
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}

/**
 * Verifies a client's presented credentials at the token or revocation
 * endpoint.
 *
 * A public client (`token_endpoint_auth_method: "none"`) authenticates with
 * `client_id` alone. That is not a weakness of this implementation but the
 * defined shape of a public client, and it is why PKCE is mandatory: the code
 * is bound to a verifier only the client that started the flow holds.
 */
export function clientSecretMatches(
  client: RegisteredClient,
  presentedSecret: string | null,
): boolean {
  if (!client.clientSecretHash) {
    // A public client that nonetheless sends a secret is a confused client, not
    // an authorized one. Rejecting keeps "no secret configured" from silently
    // meaning "any secret accepted".
    return presentedSecret === null
  }
  if (!presentedSecret) return false
  return hashOAuthToken(presentedSecret) === client.clientSecretHash
}

export type RegistrationValidation =
  | { ok: true; metadata: ValidatedRegistration }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string }

export interface ValidatedRegistration {
  clientName: string
  redirectUris: string[]
  grantTypes: string[]
  scope: string
  tokenEndpointAuthMethod: string
  clientUri: string | null
  logoUri: string | null
  softwareId: string | null
}

/**
 * Which redirect URIs may be registered.
 *
 * Three families, and nothing else:
 *
 *  - `https://…` — hosted clients (`https://claude.ai/api/mcp/auth_callback`).
 *  - `http://127.0.0.1…` / `http://localhost…` — native clients per RFC 8252
 *    §7.3. Plain HTTP is safe *only* here, because the request never leaves the
 *    user's own machine. This is the family the Geode broker registers, and it
 *    registers it **portless**, which is legal and which
 *    `lib/oauth/redirect-uri.ts` is built to match.
 *  - Nothing else. Not `http://` to any other host (an authorization code in
 *    cleartext over the network), not a private-use scheme like `myapp://`
 *    (RFC 8252 allows it, but no client Compass targets uses one and an
 *    unclaimed scheme is hijackable by any app on the device), and not a URI
 *    with a fragment (RFC 6749 §3.1.2 forbids it outright).
 */
export function isRegistrableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false
  if (value.length > MAX_REDIRECT_URI_LENGTH) return false

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash) return false
  if (url.username || url.password) return false
  if (url.protocol === "https:") return true
  if (url.protocol === "http:") return isLoopbackRedirectUri(value)
  return false
}

/**
 * Validates an RFC 7591 registration request body.
 *
 * Unknown members are ignored rather than rejected — RFC 7591 §2 explicitly
 * permits extension metadata, and clients do send fields this server has no use
 * for (`software_version`, `contacts`, `tos_uri`). Rejecting them would fail
 * registration for a client that is otherwise perfectly compatible.
 */
export function validateRegistrationRequest(body: unknown): RegistrationValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", description: "Body must be a JSON object." }
  }
  const input = body as Record<string, unknown>

  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: "redirect_uris must be a non-empty array.",
    }
  }
  if (input.redirect_uris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`,
    }
  }
  if (!input.redirect_uris.every(isRegistrableRedirectUri)) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description:
        "Every redirect_uri must be an absolute https URI, or an http URI on 127.0.0.1 or localhost, with no fragment.",
    }
  }
  const redirectUris = [...new Set(input.redirect_uris as string[])]

  // RFC 7591 §2 defaults response_types to ["code"] when omitted, which is the
  // only value this server supports.
  const responseTypes = input.response_types ?? ["code"]
  if (!Array.isArray(responseTypes) || responseTypes.some((entry) => entry !== "code")) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: 'response_types must be ["code"]; this server is authorization-code only.',
    }
  }

  const grantTypes = input.grant_types ?? [GRANT_AUTHORIZATION_CODE]
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.length === 0 ||
    !grantTypes.every(
      (entry): entry is string =>
        typeof entry === "string" && (SUPPORTED_GRANT_TYPES as readonly string[]).includes(entry),
    )
  ) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: `grant_types may only contain ${SUPPORTED_GRANT_TYPES.join(" and ")}.`,
    }
  }
  // authorization_code is implied: a client that registered only
  // refresh_token could never obtain the refresh token it wants to use.
  const normalizedGrantTypes = [...new Set([GRANT_AUTHORIZATION_CODE, ...grantTypes])]

  const authMethod = input.token_endpoint_auth_method ?? AUTH_METHOD_NONE
  if (
    typeof authMethod !== "string" ||
    !(SUPPORTED_AUTH_METHODS as readonly string[]).includes(authMethod)
  ) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: `token_endpoint_auth_method must be one of ${SUPPORTED_AUTH_METHODS.join(", ")}.`,
    }
  }

  // An unrecognised scope is dropped rather than rejected, per RFC 6749 §3.3's
  // treatment of partial scope grants: the registration response echoes what was
  // actually granted, so the client learns what it got. Rejecting outright would
  // fail a client asking for a reasonable superset.
  const requestedScope = typeof input.scope === "string" ? input.scope : null
  const granted = requestedScope ? filterSupportedScopes(requestedScope) : [...SUPPORTED_SCOPES]
  if (granted.length === 0) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: `scope must request at least one of: ${SUPPORTED_SCOPES.join(", ")}.`,
    }
  }

  const clientName = optionalString(input.client_name, MAX_CLIENT_NAME_LENGTH) ?? "Unnamed client"
  const clientUri = optionalHttpsUri(input.client_uri)
  const logoUri = optionalHttpsUri(input.logo_uri)

  return {
    ok: true,
    metadata: {
      clientName,
      redirectUris,
      grantTypes: normalizedGrantTypes,
      scope: formatScope(granted),
      tokenEndpointAuthMethod: authMethod,
      clientUri,
      logoUri,
      softwareId: optionalString(input.software_id, 255),
    },
  }
}

/**
 * Writes a validated registration and returns the RFC 7591 §3.2.1 response
 * body.
 *
 * No `registration_access_token` / `registration_client_uri` is issued.
 * Those belong to RFC 7592 client management, Compass has no client
 * configuration endpoint, and handing a client a credential for an endpoint
 * that does not exist is worse than omitting both.
 */
export async function createOAuthClient(
  metadata: ValidatedRegistration,
): Promise<Record<string, unknown>> {
  const clientId = mintClientId()
  const secret =
    metadata.tokenEndpointAuthMethod === AUTH_METHOD_CLIENT_SECRET_POST ? mintClientSecret() : null

  const created = await getPrisma().oAuthClient.create({
    data: {
      clientId,
      clientSecretHash: secret?.clientSecretHash ?? null,
      clientName: metadata.clientName,
      redirectUris: metadata.redirectUris,
      grantTypes: metadata.grantTypes,
      scope: metadata.scope,
      tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
      logoUri: metadata.logoUri,
      clientUri: metadata.clientUri,
      softwareId: metadata.softwareId,
    },
    select: { createdAt: true },
  })

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
    ...(secret ? { client_secret: secret.clientSecret, client_secret_expires_at: 0 } : {}),
    client_name: metadata.clientName,
    redirect_uris: metadata.redirectUris,
    grant_types: metadata.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: metadata.tokenEndpointAuthMethod,
    scope: metadata.scope,
    ...(metadata.clientUri ? { client_uri: metadata.clientUri } : {}),
    ...(metadata.logoUri ? { logo_uri: metadata.logoUri } : {}),
    ...(metadata.softwareId ? { software_id: metadata.softwareId } : {}),
  }
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, maxLength)
}

/**
 * `client_uri` and `logo_uri` are rendered on the consent screen, so an
 * attacker-supplied `javascript:` or `data:` URI here would be a stored XSS
 * vector on the one page in the product where a user grants access. HTTPS only,
 * and dropped rather than rejected so a bad value costs the client a link
 * instead of its registration.
 */
function optionalHttpsUri(value: unknown): string | null {
  const raw = optionalString(value, MAX_URI_LENGTH)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" ? raw : null
  } catch {
    return null
  }
}
