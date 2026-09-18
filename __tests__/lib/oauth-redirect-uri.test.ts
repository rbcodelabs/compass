/**
 * The single most load-bearing piece of the OAuth phase-1 surface.
 *
 * Every client Compass targets has a different redirect shape and each one has
 * to work exactly as specified, with nothing extra admitted:
 *
 *   - the Geode broker registers a **portless** `http://127.0.0.1/callback` and
 *     then authorizes on a fresh ephemeral port every time;
 *   - Claude Code declares both `http://localhost/callback` and
 *     `http://127.0.0.1/callback`, same ephemeral-port behavior;
 *   - hosted Claude uses `https://claude.ai/api/mcp/auth_callback`, which must
 *     match byte for byte.
 *
 * The failure mode this file exists to prevent is a matcher that is *slightly*
 * too permissive — one that ignores the port for a non-loopback host, or that
 * treats `127.0.0.1.evil.com` as loopback. Those hand an attacker the victim's
 * authorization code, and they will not show up in any end-to-end test.
 */
import { describe, expect, it } from "vitest"

import {
  LOOPBACK_HOSTNAMES,
  isLoopbackRedirectUri,
  matchRedirectUri,
  redirectUriMatches,
} from "@/lib/oauth/redirect-uri"

const GEODE_REGISTERED = "http://127.0.0.1/callback"
const CLAUDE_CODE_REGISTERED = ["http://localhost/callback", "http://127.0.0.1/callback"]
const HOSTED_CLAUDE = "https://claude.ai/api/mcp/auth_callback"

describe("redirectUriMatches — exact matching", () => {
  it("accepts an identical non-loopback URI", () => {
    expect(redirectUriMatches(HOSTED_CLAUDE, HOSTED_CLAUDE)).toBe(true)
  })

  it("rejects a different path on the same registered host", () => {
    expect(redirectUriMatches(HOSTED_CLAUDE, "https://claude.ai/api/mcp/other_callback")).toBe(false)
  })

  it("rejects a path that merely extends the registered one", () => {
    // Prefix matching is the classic way this goes wrong.
    expect(redirectUriMatches(HOSTED_CLAUDE, `${HOSTED_CLAUDE}/extra`)).toBe(false)
    expect(redirectUriMatches("https://claude.ai/api", HOSTED_CLAUDE)).toBe(false)
  })

  it("rejects an added query string or fragment", () => {
    expect(redirectUriMatches(HOSTED_CLAUDE, `${HOSTED_CLAUDE}?next=https://evil.com`)).toBe(false)
    expect(redirectUriMatches(HOSTED_CLAUDE, `${HOSTED_CLAUDE}#x`)).toBe(false)
  })

  it("rejects a scheme downgrade", () => {
    expect(redirectUriMatches(HOSTED_CLAUDE, "http://claude.ai/api/mcp/auth_callback")).toBe(false)
  })

  it("rejects a different host, including a subdomain and a suffix lookalike", () => {
    expect(redirectUriMatches(HOSTED_CLAUDE, "https://evil.claude.ai/api/mcp/auth_callback")).toBe(false)
    expect(redirectUriMatches(HOSTED_CLAUDE, "https://claude.ai.evil.com/api/mcp/auth_callback")).toBe(false)
  })

  it("rejects userinfo smuggled in front of the registered host", () => {
    expect(redirectUriMatches(HOSTED_CLAUDE, "https://claude.ai@evil.com/api/mcp/auth_callback")).toBe(false)
  })

  it("rejects a wildcard-looking registration rather than expanding it", () => {
    expect(redirectUriMatches("https://*.claude.ai/cb", "https://app.claude.ai/cb")).toBe(false)
  })

  it("rejects an explicit default port on a non-loopback host", () => {
    // OAuth 2.1 mandates simple string comparison, so the normalising variant
    // (which would call these equal) is deliberately not implemented.
    expect(redirectUriMatches(HOSTED_CLAUDE, "https://claude.ai:443/api/mcp/auth_callback")).toBe(false)
  })

  it("rejects a differing port on a non-loopback host — the port is NEVER ignored off loopback", () => {
    expect(redirectUriMatches("https://example.com/cb", "https://example.com:8443/cb")).toBe(false)
    expect(redirectUriMatches("https://example.com:8443/cb", "https://example.com/cb")).toBe(false)
    expect(redirectUriMatches("https://example.com:8443/cb", "https://example.com:9443/cb")).toBe(false)
    expect(redirectUriMatches("http://example.com/cb", "http://example.com:31337/cb")).toBe(false)
  })

  it("matches a non-http scheme only exactly", () => {
    expect(redirectUriMatches("com.example.app:/oauth", "com.example.app:/oauth")).toBe(true)
    expect(redirectUriMatches("com.example.app:/oauth", "com.example.app:/other")).toBe(false)
  })
})

describe("redirectUriMatches — RFC 8252 §7.3 loopback port exception", () => {
  it("accepts any ephemeral port against a portless 127.0.0.1 registration", () => {
    for (const port of [1, 1024, 49152, 54321, 65535]) {
      expect(redirectUriMatches(GEODE_REGISTERED, `http://127.0.0.1:${port}/callback`)).toBe(true)
    }
  })

  it("accepts two different ports in a row — the cross-repo regression case", () => {
    // Re-authorizing twice from one Geode install binds a different port each
    // time. An AS with exact port matching fails only on the second attempt.
    expect(redirectUriMatches(GEODE_REGISTERED, "http://127.0.0.1:51234/callback")).toBe(true)
    expect(redirectUriMatches(GEODE_REGISTERED, "http://127.0.0.1:62000/callback")).toBe(true)
  })

  it("accepts a registration that already carries a port against a different one", () => {
    expect(redirectUriMatches("http://127.0.0.1:3000/callback", "http://127.0.0.1:8123/callback")).toBe(true)
  })

  it("covers both of Claude Code's declared loopback redirects", () => {
    expect(matchRedirectUri(CLAUDE_CODE_REGISTERED, "http://localhost:45678/callback")).toBe(
      "http://localhost/callback",
    )
    expect(matchRedirectUri(CLAUDE_CODE_REGISTERED, "http://127.0.0.1:45678/callback")).toBe(
      "http://127.0.0.1/callback",
    )
  })

  it("does not treat localhost and 127.0.0.1 as interchangeable", () => {
    expect(redirectUriMatches(GEODE_REGISTERED, "http://localhost:5000/callback")).toBe(false)
    expect(redirectUriMatches("http://localhost/callback", "http://127.0.0.1:5000/callback")).toBe(false)
  })

  it("still requires the path to match exactly", () => {
    expect(redirectUriMatches(GEODE_REGISTERED, "http://127.0.0.1:5000/other")).toBe(false)
    expect(redirectUriMatches(GEODE_REGISTERED, "http://127.0.0.1:5000/callback/extra")).toBe(false)
  })

  it("still requires the scheme to match exactly", () => {
    expect(redirectUriMatches(GEODE_REGISTERED, "https://127.0.0.1:5000/callback")).toBe(false)
  })

  it("ignores the port and nothing else: an added query or fragment is rejected", () => {
    expect(redirectUriMatches(GEODE_REGISTERED, "http://127.0.0.1:5000/callback?next=//evil.com")).toBe(false)
    expect(redirectUriMatches(GEODE_REGISTERED, "http://127.0.0.1:5000/callback#evil")).toBe(false)
  })

  it("rejects hosts that only look like loopback", () => {
    for (const requested of [
      "http://127.0.0.1.evil.com:5000/callback",
      "http://127.0.0.1@evil.com:5000/callback",
      "http://localhost.evil.com:5000/callback",
      "http://evil.com/callback",
      // IPv6 loopback is deliberately outside the carve-out — the WHATWG
      // parser keeps "[::1]" as its own host string, so this stays rejected.
      "http://[::1]:5000/callback",
      // A trailing-dot FQDN is a different host string to the parser, and
      // nothing Compass targets registers one.
      "http://localhost.:5000/callback",
    ]) {
      expect(redirectUriMatches(GEODE_REGISTERED, requested), requested).toBe(false)
    }
  })

  it("accepts alternate IPv4 spellings of 127.0.0.1, because they are 127.0.0.1", () => {
    // The WHATWG URL parser canonicalises the integer, hex and short forms to
    // "127.0.0.1", and matching on the parsed hostname inherits that. It is the
    // correct outcome rather than a hole: each of these still resolves to the
    // user's own loopback interface, so there is nowhere for a code to leak to.
    for (const requested of [
      "http://2130706433:5000/callback",
      "http://0x7f000001:5000/callback",
      "http://127.1:5000/callback",
      "http://127.0.0.01:5000/callback",
    ]) {
      expect(redirectUriMatches(GEODE_REGISTERED, requested), requested).toBe(true)
    }
  })

  it("rejects a non-loopback registration paired with a loopback request and vice versa", () => {
    expect(redirectUriMatches("https://example.com/callback", "http://127.0.0.1:5000/callback")).toBe(false)
    expect(redirectUriMatches(GEODE_REGISTERED, "http://example.com:5000/callback")).toBe(false)
  })
})

describe("redirectUriMatches — malformed input", () => {
  it.each([
    ["", "http://127.0.0.1:5000/callback"],
    ["http://127.0.0.1/callback", ""],
    ["not a uri", "not a uri"],
    ["/callback", "/callback"],
  ])("rejects (%s, %s)", (registered, requested) => {
    expect(redirectUriMatches(registered, requested)).toBe(false)
  })

  it("rejects non-string inputs without throwing", () => {
    const anyMatches = redirectUriMatches as unknown as (a: unknown, b: unknown) => boolean
    expect(anyMatches(null, "http://127.0.0.1:1/callback")).toBe(false)
    expect(anyMatches("http://127.0.0.1/callback", undefined)).toBe(false)
    expect(anyMatches(["http://127.0.0.1/callback"], "http://127.0.0.1/callback")).toBe(false)
  })
})

describe("matchRedirectUri", () => {
  it("returns the registered value that matched, not the requested one", () => {
    expect(matchRedirectUri([HOSTED_CLAUDE, GEODE_REGISTERED], "http://127.0.0.1:60000/callback")).toBe(
      GEODE_REGISTERED,
    )
  })

  it("returns null when nothing matches, including for an empty registration list", () => {
    expect(matchRedirectUri([], GEODE_REGISTERED)).toBeNull()
    expect(matchRedirectUri([HOSTED_CLAUDE], "http://127.0.0.1:60000/callback")).toBeNull()
  })

  it("returns null for a non-array registration list rather than throwing", () => {
    const anyMatch = matchRedirectUri as unknown as (a: unknown, b: string) => string | null
    expect(anyMatch(null, GEODE_REGISTERED)).toBeNull()
    expect(anyMatch("http://127.0.0.1/callback", GEODE_REGISTERED)).toBeNull()
  })
})

describe("isLoopbackRedirectUri", () => {
  it("is true for exactly the two documented hostnames", () => {
    expect(LOOPBACK_HOSTNAMES).toEqual(["127.0.0.1", "localhost"])
    expect(isLoopbackRedirectUri("http://127.0.0.1:1234/cb")).toBe(true)
    expect(isLoopbackRedirectUri("http://localhost/cb")).toBe(true)
  })

  it("is false for IPv6 loopback, lookalikes, and malformed input", () => {
    // ::1 is deliberately out of scope for the port-agnostic carve-out.
    expect(isLoopbackRedirectUri("http://[::1]:1234/cb")).toBe(false)
    expect(isLoopbackRedirectUri("http://127.0.0.1.evil.com/cb")).toBe(false)
    expect(isLoopbackRedirectUri("http://127.0.0.1@evil.com/cb")).toBe(false)
    expect(isLoopbackRedirectUri("https://claude.ai/cb")).toBe(false)
    expect(isLoopbackRedirectUri("not a uri")).toBe(false)
    expect(isLoopbackRedirectUri("")).toBe(false)
  })
})
