import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CompassUrlNotConfiguredError } from "@/lib/compass-url"
import {
  RESOURCE_SCOPES,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
  SCOPE_OFFLINE_ACCESS,
  SUPPORTED_SCOPES,
  filterSupportedScopes,
  formatScope,
  isSupportedScope,
  mcpResourceUri,
  oauthIssuer,
  parseScope,
} from "@/lib/oauth/constants"

const KEYS = ["VERCEL_ENV", "VERCEL_BRANCH_URL", "VERCEL_URL", "NEXT_PUBLIC_APP_URL"] as const
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

beforeEach(() => KEYS.forEach((key) => delete process.env[key]))
afterEach(() =>
  KEYS.forEach((key) => {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }),
)

describe("scope vocabulary", () => {
  it("is exactly the three scopes the design settles on", () => {
    expect(SUPPORTED_SCOPES).toEqual(["mcp:read", "mcp:write", "offline_access"])
    expect([SCOPE_MCP_READ, SCOPE_MCP_WRITE, SCOPE_OFFLINE_ACCESS]).toEqual([...SUPPORTED_SCOPES])
  })

  it("keeps offline_access out of the protected-resource document", () => {
    // Different file from the AS metadata; the spec's "SHOULD NOT advertise
    // offline_access" guidance applies to this one only.
    expect(RESOURCE_SCOPES).toEqual(["mcp:read", "mcp:write"])
  })

  it("stays short, because an unscoped challenge makes clients request everything listed", () => {
    expect(SUPPORTED_SCOPES.length).toBeLessThanOrEqual(3)
  })

  it("recognises supported scopes and nothing else", () => {
    expect(isSupportedScope("mcp:read")).toBe(true)
    expect(isSupportedScope("mcp:admin")).toBe(false)
    expect(isSupportedScope("MCP:READ")).toBe(false)
    expect(isSupportedScope("")).toBe(false)
  })
})

describe("parseScope / formatScope", () => {
  it("splits on whitespace and de-duplicates, preserving first-seen order", () => {
    expect(parseScope("mcp:write mcp:read mcp:write")).toEqual(["mcp:write", "mcp:read"])
    expect(parseScope("  mcp:read\tmcp:write \n offline_access ")).toEqual([
      "mcp:read",
      "mcp:write",
      "offline_access",
    ])
  })

  it("treats absent and empty scope strings as no scopes", () => {
    expect(parseScope(undefined)).toEqual([])
    expect(parseScope(null)).toEqual([])
    expect(parseScope("")).toEqual([])
    expect(parseScope("   ")).toEqual([])
  })

  it("round-trips through formatScope", () => {
    expect(formatScope(parseScope("mcp:read mcp:write"))).toBe("mcp:read mcp:write")
    expect(formatScope(["mcp:read", "mcp:read"])).toBe("mcp:read")
    expect(formatScope([])).toBe("")
  })

  it("drops unsupported scopes rather than rejecting the whole request", () => {
    expect(filterSupportedScopes("mcp:read admin:everything mcp:write")).toEqual([
      "mcp:read",
      "mcp:write",
    ])
    expect(filterSupportedScopes("nothing:here")).toEqual([])
  })
})

describe("oauthIssuer", () => {
  it("is the production origin with no path and no trailing slash", () => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
    expect(oauthIssuer()).toBe("https://compass.rbcodelabs.com")
  })

  it("strips a trailing slash a configured origin happens to carry", () => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com/"
    expect(oauthIssuer()).toBe("https://compass.rbcodelabs.com")
  })

  it("uses the per-branch preview host, which is stable across pushes", () => {
    // VERCEL_URL changes per deployment; clients byte-compare `issuer`, so the
    // branch URL is the only preview host that can back an OAuth issuer.
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_BRANCH_URL = "compass-git-feat-mcp-oauth-rbcodelabs.vercel.app"
    process.env.VERCEL_URL = "compass-9f3a2b1.vercel.app"
    expect(oauthIssuer()).toBe("https://compass-git-feat-mcp-oauth-rbcodelabs.vercel.app")
  })

  it("allows http only on loopback, for local development", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"
    expect(oauthIssuer()).toBe("http://localhost:3000")
  })

  it("propagates a missing-configuration failure rather than inventing an issuer", () => {
    process.env.VERCEL_ENV = "production"
    expect(() => oauthIssuer()).toThrow(CompassUrlNotConfiguredError)
  })
})

describe("mcpResourceUri", () => {
  it("is the canonical MCP endpoint: HTTPS, no fragment, no trailing slash", () => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
    const resource = mcpResourceUri()
    expect(resource).toBe("https://compass.rbcodelabs.com/api/mcp")
    expect(resource.endsWith("/")).toBe(false)
    expect(resource).not.toContain("#")
  })

  it("is exactly the URL a user pastes into their MCP client", () => {
    // The audience predicate on every token lookup compares against this
    // string, so any drift silently rejects every token.
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com/"
    expect(mcpResourceUri()).toBe("https://compass.rbcodelabs.com/api/mcp")
  })

  it("shares an origin with the issuer — Compass is its own authorization server", () => {
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_BRANCH_URL = "compass-git-feat-mcp-oauth-rbcodelabs.vercel.app"
    expect(mcpResourceUri().startsWith(`${oauthIssuer()}/`)).toBe(true)
  })

  it("propagates a missing-configuration failure", () => {
    process.env.VERCEL_ENV = "production"
    expect(() => mcpResourceUri()).toThrow(CompassUrlNotConfiguredError)
  })
})
