/**
 * The authorization-code, client-id and client-secret minters added alongside
 * the access/refresh pair, and the client-credential comparison built on them.
 */
import { describe, expect, it } from "vitest"
import {
  AUTHORIZATION_CODE_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  hashOAuthToken,
  isOAuthAuthorizationCode,
  mintAuthorizationCode,
  mintClientId,
  mintClientSecret,
  oauthTokenType,
} from "@/lib/oauth/tokens"
import { clientSecretMatches, isRegistrableRedirectUri, parseJsonStringArray } from "@/lib/oauth/clients"

describe("mintAuthorizationCode", () => {
  it("produces cmp_oac_<32 hex>, matching the cmp_oat_/cmp_ort_ pattern", () => {
    const { code, codeHash } = mintAuthorizationCode()
    expect(code).toMatch(/^cmp_oac_[0-9a-f]{32}$/)
    expect(code.startsWith(AUTHORIZATION_CODE_PREFIX)).toBe(true)
    // The same generic SHA-256 the tokens use — OAuthAuthorizationCode.codeHash
    // is the same VarChar(64) column shape as OAuthToken.tokenHash.
    expect(codeHash).toBe(hashOAuthToken(code))
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("never repeats", () => {
    const codes = new Set(Array.from({ length: 200 }, () => mintAuthorizationCode().code))
    expect(codes.size).toBe(200)
  })

  it("is not mistaken for an access or refresh token", () => {
    // A code must never satisfy a bearer-token lookup.
    expect(oauthTokenType(mintAuthorizationCode().code)).toBeNull()
  })
})

describe("isOAuthAuthorizationCode", () => {
  it("is structural only — shape, never validity", () => {
    expect(isOAuthAuthorizationCode(mintAuthorizationCode().code)).toBe(true)
    expect(isOAuthAuthorizationCode(`${AUTHORIZATION_CODE_PREFIX}${"0".repeat(32)}`)).toBe(true)
  })

  it("rejects wrong length, wrong alphabet, wrong prefix and non-strings", () => {
    expect(isOAuthAuthorizationCode(`${AUTHORIZATION_CODE_PREFIX}${"0".repeat(31)}`)).toBe(false)
    expect(isOAuthAuthorizationCode(`${AUTHORIZATION_CODE_PREFIX}${"G".repeat(32)}`)).toBe(false)
    expect(isOAuthAuthorizationCode(`${AUTHORIZATION_CODE_PREFIX}${"A".repeat(32)}`)).toBe(false)
    expect(isOAuthAuthorizationCode(`cmp_oat_${"0".repeat(32)}`)).toBe(false)
    expect(isOAuthAuthorizationCode("")).toBe(false)
    expect(isOAuthAuthorizationCode(undefined as unknown as string)).toBe(false)
  })
})

describe("mintClientId / mintClientSecret", () => {
  it("mints an unguessable client_id that fits the VarChar(64) column", () => {
    const clientId = mintClientId()
    expect(clientId).toMatch(/^cmp_oc_[0-9a-f]{32}$/)
    expect(clientId.startsWith(CLIENT_ID_PREFIX)).toBe(true)
    // client_id alone authenticates a public client at the token endpoint, so
    // it must not be enumerable even though it is not a secret.
    expect(clientId.length).toBeLessThanOrEqual(64)
  })

  it("mints a secret whose hash fits the VarChar(64) column", () => {
    const { clientSecret, clientSecretHash } = mintClientSecret()
    expect(clientSecret.startsWith(CLIENT_SECRET_PREFIX)).toBe(true)
    expect(clientSecretHash).toHaveLength(64)
    expect(clientSecretHash).toBe(hashOAuthToken(clientSecret))
  })
})

describe("clientSecretMatches", () => {
  const publicClient = { clientSecretHash: null } as Parameters<typeof clientSecretMatches>[0]

  it("authenticates a public client on client_id alone", () => {
    expect(clientSecretMatches(publicClient, null)).toBe(true)
  })

  it("rejects a public client that sends a secret anyway", () => {
    // Otherwise "no secret configured" silently means "any secret accepted".
    expect(clientSecretMatches(publicClient, "anything")).toBe(false)
  })

  it("compares a confidential client's secret by hash", () => {
    const { clientSecret, clientSecretHash } = mintClientSecret()
    const confidential = { clientSecretHash } as Parameters<typeof clientSecretMatches>[0]
    expect(clientSecretMatches(confidential, clientSecret)).toBe(true)
    expect(clientSecretMatches(confidential, "cmp_ocs_wrong")).toBe(false)
    expect(clientSecretMatches(confidential, null)).toBe(false)
  })
})

describe("parseJsonStringArray", () => {
  it("narrows a Json column to the strings it should hold", () => {
    expect(parseJsonStringArray(["a", "b"])).toEqual(["a", "b"])
  })

  it("drops anything that is not a non-empty string", () => {
    // redirect_uris is JSONB — a row written by a migration or a hand-edit could
    // hold anything, and a non-string reaching redirectUriMatches would be worse
    // than an empty list.
    expect(parseJsonStringArray(["ok", "", null, 42, { a: 1 }] as never)).toEqual(["ok"])
  })

  it("returns an empty list for a non-array", () => {
    for (const value of [null, undefined, "string", 42, { a: 1 }]) {
      expect(parseJsonStringArray(value as never)).toEqual([])
    }
  })
})

describe("isRegistrableRedirectUri", () => {
  it("accepts https, and http only on loopback", () => {
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true)
    expect(isRegistrableRedirectUri("http://127.0.0.1/callback")).toBe(true)
    expect(isRegistrableRedirectUri("http://localhost:8765/callback")).toBe(true)
  })

  it("rejects everything else", () => {
    expect(isRegistrableRedirectUri("http://evil.example.com/cb")).toBe(false)
    expect(isRegistrableRedirectUri("myapp://cb")).toBe(false)
    expect(isRegistrableRedirectUri("javascript:alert(1)")).toBe(false)
    expect(isRegistrableRedirectUri("https://claude.ai/cb#frag")).toBe(false)
    expect(isRegistrableRedirectUri("https://user:pass@claude.ai/cb")).toBe(false)
    expect(isRegistrableRedirectUri("not a uri")).toBe(false)
    expect(isRegistrableRedirectUri(42)).toBe(false)
  })
})
