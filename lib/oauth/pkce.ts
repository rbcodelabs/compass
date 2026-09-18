/**
 * PKCE (RFC 7636) verification — S256 only.
 *
 * `plain` is rejected everywhere, including the RFC's default-when-omitted
 * case: RFC 7636 §4.3 says an absent `code_challenge_method` means `plain`, and
 * Compass does not support `plain`, so an absent method is an error rather than
 * a silent downgrade. `code_challenge_methods_supported: ["S256"]` in the AS
 * metadata is what tells clients this up front — MCP clients MUST refuse to
 * proceed if that key is missing.
 */
import { createHash, timingSafeEqual } from "node:crypto"

export const CODE_CHALLENGE_METHOD_S256 = "S256"
export const SUPPORTED_CODE_CHALLENGE_METHODS = [CODE_CHALLENGE_METHOD_S256] as const

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/
/** base64url of a SHA-256 digest is always 43 unpadded characters. */
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/

export type PkceFailure = {
  ok: false
  /** The OAuth error code to return on the wire. */
  error: "invalid_request" | "invalid_grant"
  description: string
}

export type PkceResult = { ok: true } | PkceFailure

/** `BASE64URL-ENCODE(SHA256(ASCII(verifier)))`, per RFC 7636 §4.2. */
export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url")
}

/**
 * Authorize-endpoint check: is this a `code_challenge`/`code_challenge_method`
 * pair Compass will accept and store? Failures here are `invalid_request`
 * because nothing has been issued yet.
 */
export function validateCodeChallenge(
  codeChallenge: string | null | undefined,
  codeChallengeMethod: string | null | undefined,
): PkceResult {
  if (!codeChallenge) {
    return {
      ok: false,
      error: "invalid_request",
      description: "code_challenge is required; Compass requires PKCE.",
    }
  }
  if (!codeChallengeMethod) {
    return {
      ok: false,
      error: "invalid_request",
      description:
        "code_challenge_method is required and must be S256; an omitted method means plain, which is not supported.",
    }
  }
  if (codeChallengeMethod !== CODE_CHALLENGE_METHOD_S256) {
    return {
      ok: false,
      error: "invalid_request",
      description: `Unsupported code_challenge_method "${codeChallengeMethod}"; only S256 is supported.`,
    }
  }
  if (!S256_CHALLENGE_PATTERN.test(codeChallenge)) {
    return {
      ok: false,
      error: "invalid_request",
      description: "code_challenge must be a 43-character base64url SHA-256 digest.",
    }
  }
  return { ok: true }
}

/**
 * Token-endpoint check: does `codeVerifier` hash to the challenge recorded when
 * the authorization code was issued? Failures here are `invalid_grant` — the
 * request is well-formed, the proof just does not hold.
 */
export function verifyPkce(input: {
  codeChallenge: string | null | undefined
  codeChallengeMethod: string | null | undefined
  codeVerifier: string | null | undefined
}): PkceResult {
  const stored = validateCodeChallenge(input.codeChallenge, input.codeChallengeMethod)
  if (!stored.ok) return stored

  if (!input.codeVerifier) {
    return { ok: false, error: "invalid_grant", description: "code_verifier is required." }
  }
  if (!VERIFIER_PATTERN.test(input.codeVerifier)) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "code_verifier must be 43-128 unreserved characters.",
    }
  }
  if (!constantTimeEquals(computeS256Challenge(input.codeVerifier), input.codeChallenge!)) {
    return {
      ok: false,
      error: "invalid_grant",
      description: "code_verifier does not match the stored code_challenge.",
    }
  }
  return { ok: true }
}

/**
 * Both sides are fixed-length base64url digests here, so the length check
 * leaks nothing an attacker does not already know from the format.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
