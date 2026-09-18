import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  TOKEN_SECRET_LENGTH,
  hashOAuthToken,
  isOAuthAccessToken,
  isOAuthRefreshToken,
  mintOAuthToken,
  oauthTokenType,
} from "@/lib/oauth/tokens"

describe("mintOAuthToken", () => {
  it("mints cmp_oat_<32 hex> access tokens", () => {
    const { token, type } = mintOAuthToken("ACCESS")
    expect(type).toBe("ACCESS")
    expect(token).toMatch(/^cmp_oat_[0-9a-f]{32}$/)
    expect(ACCESS_TOKEN_PREFIX).toBe("cmp_oat_")
  })

  it("mints cmp_ort_<32 hex> refresh tokens", () => {
    const { token, type } = mintOAuthToken("REFRESH")
    expect(type).toBe("REFRESH")
    expect(token).toMatch(/^cmp_ort_[0-9a-f]{32}$/)
    expect(REFRESH_TOKEN_PREFIX).toBe("cmp_ort_")
  })

  it("carries the same 128 bits of entropy as an existing cmp_ API key", () => {
    expect(TOKEN_SECRET_LENGTH).toBe(32)
  })

  it("returns a hash that matches SHA-256 over the whole token, prefix included", () => {
    // lib/mcp-auth.ts hashes the full cmp_… value rather than its random part;
    // diverging here would silently break any shared lookup helper later.
    const { token, tokenHash } = mintOAuthToken("ACCESS")
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"))
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).not.toContain(token.slice(ACCESS_TOKEN_PREFIX.length))
  })

  it("is not a JWT — the token body carries no structure to decode", () => {
    expect(mintOAuthToken("ACCESS").token).not.toContain(".")
  })

  it("never repeats", () => {
    const minted = new Set(Array.from({ length: 500 }, () => mintOAuthToken("ACCESS").token))
    expect(minted.size).toBe(500)
  })
})

describe("hashOAuthToken", () => {
  it("is deterministic and 64 lowercase hex characters", () => {
    expect(hashOAuthToken("cmp_oat_deadbeef")).toBe(hashOAuthToken("cmp_oat_deadbeef"))
    expect(hashOAuthToken("cmp_oat_deadbeef")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("distinguishes an access token from a refresh token with the same secret", () => {
    const secret = "a".repeat(32)
    expect(hashOAuthToken(`${ACCESS_TOKEN_PREFIX}${secret}`)).not.toBe(
      hashOAuthToken(`${REFRESH_TOKEN_PREFIX}${secret}`),
    )
  })
})

describe("oauthTokenType", () => {
  it("classifies well-formed tokens of both kinds", () => {
    expect(oauthTokenType(mintOAuthToken("ACCESS").token)).toBe("ACCESS")
    expect(oauthTokenType(mintOAuthToken("REFRESH").token)).toBe("REFRESH")
  })

  it("rejects values that are not Compass OAuth tokens", () => {
    for (const value of [
      "",
      "cmp_0123456789abcdef0123456789abcdef", // an existing static API key
      "Bearer cmp_oat_0123456789abcdef0123456789abcdef",
      "cmp_oat_", // no secret
      `cmp_oat_${"a".repeat(31)}`, // one hex digit short
      `cmp_oat_${"a".repeat(33)}`, // one too long
      `cmp_oat_${"A".repeat(32)}`, // uppercase hex is not what we mint
      `cmp_oat_${"g".repeat(32)}`, // not hex at all
      `cmp_oat_${"a".repeat(30)}==`,
      "cmp_oauth_0123456789abcdef0123456789abcdef",
      "eyJhbGciOiJIUzI1NiJ9.e30.x",
    ]) {
      expect(oauthTokenType(value), value).toBeNull()
    }
  })

  it("backs the isOAuth* predicates without cross-talk", () => {
    const access = mintOAuthToken("ACCESS").token
    const refresh = mintOAuthToken("REFRESH").token
    expect(isOAuthAccessToken(access)).toBe(true)
    expect(isOAuthRefreshToken(access)).toBe(false)
    expect(isOAuthRefreshToken(refresh)).toBe(true)
    expect(isOAuthAccessToken(refresh)).toBe(false)
    expect(isOAuthAccessToken("cmp_0123456789abcdef0123456789abcdef")).toBe(false)
  })
})
