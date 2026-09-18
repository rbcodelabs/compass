import { createHash, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  CODE_CHALLENGE_METHOD_S256,
  SUPPORTED_CODE_CHALLENGE_METHODS,
  computeS256Challenge,
  validateCodeChallenge,
  verifyPkce,
} from "@/lib/oauth/pkce"

/** A verifier of the shape RFC 7636 §4.1 requires. */
function newVerifier(): string {
  return randomBytes(32).toString("base64url")
}

describe("computeS256Challenge", () => {
  it("is BASE64URL-ENCODE(SHA256(ASCII(verifier)))", () => {
    const verifier = newVerifier()
    expect(computeS256Challenge(verifier)).toBe(
      createHash("sha256").update(verifier, "ascii").digest("base64url"),
    )
  })

  it("matches the worked example from RFC 7636 appendix B", () => {
    expect(computeS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  it("always produces an unpadded 43-character base64url digest", () => {
    expect(computeS256Challenge(newVerifier())).toMatch(/^[A-Za-z0-9\-_]{43}$/)
  })
})

describe("validateCodeChallenge", () => {
  const challenge = computeS256Challenge(newVerifier())

  it("advertises S256 and only S256", () => {
    expect(SUPPORTED_CODE_CHALLENGE_METHODS).toEqual(["S256"])
    expect(CODE_CHALLENGE_METHOD_S256).toBe("S256")
  })

  it("accepts a well-formed S256 challenge", () => {
    expect(validateCodeChallenge(challenge, "S256")).toEqual({ ok: true })
  })

  it("rejects a missing code_challenge as invalid_request", () => {
    for (const missing of [undefined, null, ""]) {
      const result = validateCodeChallenge(missing, "S256")
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toBe("invalid_request")
    }
  })

  it("rejects plain outright", () => {
    const result = validateCodeChallenge(challenge, "plain")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe("invalid_request")
    expect(result.ok === false && result.description).toContain("S256")
  })

  it("rejects an omitted method rather than silently defaulting to plain", () => {
    // RFC 7636 §4.3 says an absent method means "plain". Compass does not
    // support plain, so absent must be an error, not a downgrade.
    for (const missing of [undefined, null, ""]) {
      const result = validateCodeChallenge(challenge, missing)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toBe("invalid_request")
    }
  })

  it("rejects case variants and unknown methods", () => {
    for (const method of ["s256", "S-256", "S512", "sha256", "PLAIN", "none"]) {
      expect(validateCodeChallenge(challenge, method).ok, method).toBe(false)
    }
  })

  it("rejects a challenge that is not a 43-character base64url digest", () => {
    for (const bad of [
      challenge.slice(0, 42),
      `${challenge}A`,
      // standard base64 rather than base64url
      createHash("sha256").update("x").digest("base64"),
      "!".repeat(43),
      `${challenge.slice(0, 42)}=`,
    ]) {
      expect(validateCodeChallenge(bad, "S256").ok, bad).toBe(false)
    }
  })
})

describe("verifyPkce", () => {
  it("accepts the verifier that produced the stored challenge", () => {
    const codeVerifier = newVerifier()
    expect(
      verifyPkce({
        codeChallenge: computeS256Challenge(codeVerifier),
        codeChallengeMethod: "S256",
        codeVerifier,
      }),
    ).toEqual({ ok: true })
  })

  it("rejects a different verifier as invalid_grant", () => {
    const result = verifyPkce({
      codeChallenge: computeS256Challenge(newVerifier()),
      codeChallengeMethod: "S256",
      codeVerifier: newVerifier(),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe("invalid_grant")
  })

  it("rejects a missing verifier as invalid_grant", () => {
    for (const missing of [undefined, null, ""]) {
      const result = verifyPkce({
        codeChallenge: computeS256Challenge(newVerifier()),
        codeChallengeMethod: "S256",
        codeVerifier: missing,
      })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toBe("invalid_grant")
    }
  })

  it("rejects a verifier outside RFC 7636's length and character set", () => {
    for (const codeVerifier of [
      "a".repeat(42), // one short of the 43 minimum
      "a".repeat(129), // one past the 128 maximum
      `${"a".repeat(42)}+`, // "+" and "/" are base64, not base64url
      `${"a".repeat(42)}/`,
      `${"a".repeat(42)} `,
      `${"a".repeat(42)}%`,
    ]) {
      const result = verifyPkce({
        codeChallenge: computeS256Challenge(codeVerifier),
        codeChallengeMethod: "S256",
        codeVerifier,
      })
      // Even though the challenge was derived from this very verifier, the
      // verifier's shape disqualifies it.
      expect(result.ok, codeVerifier).toBe(false)
      expect(result.ok === false && result.error).toBe("invalid_grant")
    }
  })

  it("will not fall back to plain even when verifier and challenge are equal", () => {
    // The plain-method transform is verifier === challenge. If S256-only
    // enforcement ever regressed, this case is what would start passing.
    const codeVerifier = newVerifier()
    const result = verifyPkce({
      codeChallenge: codeVerifier,
      codeChallengeMethod: "plain",
      codeVerifier,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe("invalid_request")
  })

  it("rejects a stored challenge that was never valid, before comparing anything", () => {
    const result = verifyPkce({
      codeChallenge: null,
      codeChallengeMethod: "S256",
      codeVerifier: newVerifier(),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe("invalid_request")
  })
})
