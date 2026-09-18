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
    if (!token.startsWith(prefix)) continue
    const secret = token.slice(prefix.length)
    if (secret.length !== TOKEN_SECRET_LENGTH) return null
    if (!/^[0-9a-f]+$/.test(secret)) return null
    return type
  }
  return null
}

export function isOAuthAccessToken(token: string): boolean {
  return oauthTokenType(token) === "ACCESS"
}

export function isOAuthRefreshToken(token: string): boolean {
  return oauthTokenType(token) === "REFRESH"
}
