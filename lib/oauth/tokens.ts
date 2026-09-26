/**
 * Opaque OAuth token minting and hashing.
 *
 * Deliberately *not* a JWT. Compass stores a SHA-256 hash and looks the token
 * up on each request, mirroring the two precedents already in this codebase —
 * `ApiKey.keyHash` (lib/mcp-auth.ts) and `PortalSession.tokenHash`. That buys
 * instant revocation for free and costs nothing extra, because the MCP route
 * already performs one DB read per request to validate `cmp_…` API keys.
 */
import { createHash, randomBytes } from "node:crypto"

export const ACCESS_TOKEN_PREFIX = "cmp_oat_"
export const REFRESH_TOKEN_PREFIX = "cmp_ort_"
/**
 * Authorization codes. Not a bearer token — it is exchanged once, within 60 s,
 * at the token endpoint — but it is a secret of the same shape and is stored
 * the same way (`OAuthAuthorizationCode.codeHash` is the same `VarChar(64)`
 * SHA-256 hex column as `OAuthToken.tokenHash`), so it is minted here rather
 * than growing a second, subtly different random-secret helper.
 */
export const AUTHORIZATION_CODE_PREFIX = "cmp_oac_"
/**
 * Client identifiers. Public — it travels in a query string and is not a
 * secret — but it is minted from the same CSPRNG so it cannot be guessed or
 * enumerated, which matters because `client_id` alone authenticates a public
 * client at the token endpoint.
 */
export const CLIENT_ID_PREFIX = "cmp_oc_"
/**
 * Client secrets, issued only to a client that registers with
 * `token_endpoint_auth_method: "client_secret_post"`. No client Compass
 * targets does — every one of them is public — but the AS metadata advertises
 * the method, so it has to actually work.
 */
export const CLIENT_SECRET_PREFIX = "cmp_ocs_"

/**
 * 16 random bytes rendered as 32 hex characters — the same 128 bits of entropy
 * the existing `cmp_<32 hex>` API keys carry.
 */
const SECRET_BYTES = 16
export const TOKEN_SECRET_LENGTH = SECRET_BYTES * 2

/** Matches the `type` column on `OAuthToken`. */
export type OAuthTokenType = "ACCESS" | "REFRESH"

const PREFIX_BY_TYPE: Record<OAuthTokenType, string> = {
  ACCESS: ACCESS_TOKEN_PREFIX,
  REFRESH: REFRESH_TOKEN_PREFIX,
}

export interface MintedOAuthToken {
  type: OAuthTokenType
  /** The bearer value. Returned to the client once and never stored. */
  token: string
  /** Lowercase hex SHA-256 of `token`. This is what goes in the database. */
  tokenHash: string
}

export function mintOAuthToken(type: OAuthTokenType): MintedOAuthToken {
  const token = `${PREFIX_BY_TYPE[type]}${randomBytes(SECRET_BYTES).toString("hex")}`
  return { type, token, tokenHash: hashOAuthToken(token) }
}

/**
 * Lowercase hex SHA-256 over the **whole** token string, prefix included —
 * matching `lib/mcp-auth.ts`, which hashes the full `cmp_…` value rather than
 * just its random part. Also the hash used for authorization codes.
 */
export function hashOAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * The token type a bearer value claims to be, or `null` when it is not one of
 * ours. Purely structural: it proves nothing about validity, it only says which
 * table (and which lookup) the value is a candidate for.
 */
export function oauthTokenType(token: string): OAuthTokenType | null {
  for (const [type, prefix] of Object.entries(PREFIX_BY_TYPE) as [OAuthTokenType, string][]) {
    if (hasShape(token, prefix)) return type
  }
  return null
}

export function isOAuthAccessToken(token: string): boolean {
  return oauthTokenType(token) === "ACCESS"
}

export function isOAuthRefreshToken(token: string): boolean {
  return oauthTokenType(token) === "REFRESH"
}

/** `SECRET_BYTES` of CSPRNG output rendered as lowercase hex, behind `prefix`. */
function mintPrefixedSecret(prefix: string): string {
  return `${prefix}${randomBytes(SECRET_BYTES).toString("hex")}`
}

export interface MintedAuthorizationCode {
  /** Returned to the client in the authorization response. Never stored. */
  code: string
  /** Lowercase hex SHA-256 of `code` — the `OAuthAuthorizationCode.codeHash` value. */
  codeHash: string
}

export function mintAuthorizationCode(): MintedAuthorizationCode {
  const code = mintPrefixedSecret(AUTHORIZATION_CODE_PREFIX)
  return { code, codeHash: hashOAuthToken(code) }
}

/**
 * Structural check only, exactly like {@link oauthTokenType}: it says the value
 * is shaped like one of our codes, never that it is live or unconsumed.
 */
export function isOAuthAuthorizationCode(code: string): boolean {
  return hasShape(code, AUTHORIZATION_CODE_PREFIX)
}

/** A fresh `client_id`. Public, but unguessable — see {@link CLIENT_ID_PREFIX}. */
export function mintClientId(): string {
  return mintPrefixedSecret(CLIENT_ID_PREFIX)
}

export interface MintedClientSecret {
  clientSecret: string
  clientSecretHash: string
}

export function mintClientSecret(): MintedClientSecret {
  const clientSecret = mintPrefixedSecret(CLIENT_SECRET_PREFIX)
  return { clientSecret, clientSecretHash: hashOAuthToken(clientSecret) }
}

function hasShape(value: string, prefix: string): boolean {
  if (typeof value !== "string" || !value.startsWith(prefix)) return false
  const secret = value.slice(prefix.length)
  return secret.length === TOKEN_SECRET_LENGTH && /^[0-9a-f]+$/.test(secret)
}
