/**
 * `callbackUrl` is attacker-controllable — anyone can hand a Compass user a
 * `/login?callbackUrl=…` link. The only thing standing between that and an open
 * redirect is this validator, so the attack cases below are the point of the
 * file, not decoration.
 */
import { describe, expect, it } from "vitest"

import { DEFAULT_POST_LOGIN_PATH, safeCallbackUrl } from "@/lib/safe-callback-url"

describe("safeCallbackUrl — accepted values", () => {
  it("passes through an ordinary relative path", () => {
    expect(safeCallbackUrl("/dashboard")).toBe("/dashboard")
    expect(safeCallbackUrl("/acme/product/opportunities")).toBe("/acme/product/opportunities")
    expect(safeCallbackUrl("/")).toBe("/")
  })

  it("preserves a full OAuth authorize query string intact", () => {
    // This is the entire reason the parameter exists. Losing any of these
    // breaks the flow for every not-currently-signed-in user.
    const authorize =
      "/oauth/authorize?response_type=code&client_id=c_123&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback" +
      "&state=abc123&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256" +
      "&scope=mcp%3Aread+mcp%3Awrite&resource=https%3A%2F%2Fcompass.rbcodelabs.com%2Fapi%2Fmcp"
    const result = safeCallbackUrl(authorize)
    expect(result).toBe(authorize)
    for (const key of [
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "scope",
    ]) {
      expect(result, key).toContain(`${key}=`)
    }
  })

  it("does not decode percent-encoded separators inside the query string", () => {
    expect(safeCallbackUrl("/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback")).toContain(
      "http%3A%2F%2F127.0.0.1%2Fcallback",
    )
  })

  it("keeps a fragment", () => {
    expect(safeCallbackUrl("/docs/page#section")).toBe("/docs/page#section")
  })

  it("keeps a percent-encoded path that only looks like an absolute URL", () => {
    // Browsers do not decode before resolving, so this stays same-origin.
    expect(safeCallbackUrl("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com")
  })
})

describe("safeCallbackUrl — open-redirect attacks", () => {
  it.each([
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/steal"],
    ["triple slash", "///evil.com"],
    ["absolute https", "https://evil.com"],
    ["absolute http", "http://evil.com/steal"],
    ["backslash escape", "/\\evil.com"],
    ["double backslash", "\\\\evil.com"],
    ["mixed slash-backslash", "/\\/evil.com"],
    ["backslash after path", "/dashboard\\@evil.com"],
    ["scheme-relative with userinfo", "//compass.rbcodelabs.com@evil.com"],
    ["absolute with userinfo", "https://compass.rbcodelabs.com@evil.com/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["encoded protocol-relative", "%2F%2Fevil.com"],
    ["encoded absolute", "https%3A%2F%2Fevil.com"],
    ["double-encoded protocol-relative", "%252F%252Fevil.com"],
    ["uppercase-encoded slash", "%2f%2fevil.com"],
    ["leading whitespace before scheme", " https://evil.com"],
    ["tab-split protocol-relative", "/\t/evil.com"],
    ["newline-split protocol-relative", "/\n/evil.com"],
    ["carriage return", "/\r/evil.com"],
    ["null byte", "/dashboard\u0000"],
    ["DEL character", "/dashboard\u007f"],
    ["bare relative, not root-relative", "evil.com"],
    ["dot-relative", "./evil.com"],
    ["parent-relative", "../evil.com"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["mailto", "mailto:someone@evil.com"],
    ["file scheme", "file:///etc/passwd"],
  ])("falls back for %s", (_label, candidate) => {
    expect(safeCallbackUrl(candidate)).toBe(DEFAULT_POST_LOGIN_PATH)
  })

  it("falls back for a value long enough to be a payload rather than a path", () => {
    expect(safeCallbackUrl(`/${"a".repeat(4096)}`)).toBe(DEFAULT_POST_LOGIN_PATH)
  })
})

describe("safeCallbackUrl — absent and ambiguous input", () => {
  it("falls back when the parameter is missing", () => {
    expect(safeCallbackUrl(undefined)).toBe(DEFAULT_POST_LOGIN_PATH)
    expect(safeCallbackUrl(null)).toBe(DEFAULT_POST_LOGIN_PATH)
    expect(DEFAULT_POST_LOGIN_PATH).toBe("/dashboard")
  })

  it("falls back for a repeated parameter rather than guessing which copy won", () => {
    // Next yields string[] for ?callbackUrl=/a&callbackUrl=//evil.com — taking
    // either one is a guess, and one of the guesses is an open redirect.
    expect(safeCallbackUrl(["/dashboard", "//evil.com"])).toBe(DEFAULT_POST_LOGIN_PATH)
    expect(safeCallbackUrl(["/dashboard"])).toBe(DEFAULT_POST_LOGIN_PATH)
  })

  it("falls back for non-string input without throwing", () => {
    const anySafe = safeCallbackUrl as unknown as (raw: unknown) => string
    for (const value of [0, 1, true, {}, { toString: () => "//evil.com" }]) {
      expect(anySafe(value)).toBe(DEFAULT_POST_LOGIN_PATH)
    }
  })

  it("honours an explicit fallback, and applies it to rejected input too", () => {
    expect(safeCallbackUrl(undefined, "/settings")).toBe("/settings")
    expect(safeCallbackUrl("//evil.com", "/settings")).toBe("/settings")
    expect(safeCallbackUrl("/dashboard", "/settings")).toBe("/dashboard")
  })
})

describe("safeCallbackUrl — idempotence", () => {
  it("re-validating an already-validated value is a no-op", () => {
    // proxy.ts validates on the way in and /login validates again on the way
    // out; the second pass must not mangle the first pass's output.
    for (const candidate of [
      "/dashboard",
      "/oauth/authorize?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback",
      "/docs#anchor",
      "//evil.com",
    ]) {
      const once = safeCallbackUrl(candidate)
      expect(safeCallbackUrl(once)).toBe(once)
    }
  })
})
