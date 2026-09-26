/**
 * The two discovery documents.
 *
 * Most of what follows guards against a *specific observed client failure*
 * rather than a general notion of correctness, so each test says which:
 *
 *  - a `null` value anywhere Zod-fails Claude Code (anthropics/claude-code#38102)
 *  - a missing `code_challenge_methods_supported` makes MCP clients refuse to proceed
 *  - an advertised `client_id_metadata_document_supported` sends Claude down a
 *    flow this server does not implement instead of falling back to DCR
 *  - a drifting `issuer` fails the byte-comparison clients perform
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AUTHORIZATION_SERVER_METADATA_PATHS,
  PROTECTED_RESOURCE_METADATA_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "@/lib/oauth/metadata"

const ORIGIN = "https://compass.example.com"

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
})
afterEach(() => vi.unstubAllEnvs())

/** Recursively collects every key whose value is null or undefined. */
function nullishKeys(document: Record<string, unknown>): string[] {
  return Object.entries(document)
    .filter(([, value]) => value === null || value === undefined)
    .map(([key]) => key)
}

describe("authorizationServerMetadata", () => {
  it("advertises S256 PKCE — clients MUST refuse to proceed without it", () => {
    expect(authorizationServerMetadata().code_challenge_methods_supported).toEqual(["S256"])
  })

  it("never emits a null value for an unsupported key", () => {
    // Claude Code Zod-fails on "registration_endpoint": null. Omission is the
    // only correct way to say "not supported".
    expect(nullishKeys(authorizationServerMetadata())).toEqual([])
  })

  it("does not advertise CIMD, in any form", () => {
    const document = authorizationServerMetadata()
    // Not `false`, not `null` — absent. Decision 5: advertising it makes Claude
    // attempt a flow that does not exist rather than falling back to DCR.
    expect("client_id_metadata_document_supported" in document).toBe(false)
  })

  it("exposes a registration_endpoint, which is blocking for the Geode broker", () => {
    // OAuthMcpRegistry.ts hard-fails with "authorization server does not support
    // Dynamic Client Registration" when this key is absent.
    expect(authorizationServerMetadata().registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`)
  })

  it('accepts public clients via "none"', () => {
    // Every client here is public; a loopback client cannot hold a secret.
    expect(authorizationServerMetadata().token_endpoint_auth_methods_supported).toContain("none")
  })

  it("advertises RFC 9207 iss support, which the authorize endpoint implements", () => {
    expect(authorizationServerMetadata().authorization_response_iss_parameter_supported).toBe(true)
  })

  it("advertises offline_access so Claude requests a refresh token", () => {
    // Compass issues one regardless — this key only affects whether Claude asks.
    expect(authorizationServerMetadata().scopes_supported).toEqual([
      "mcp:read",
      "mcp:write",
      "offline_access",
    ])
  })

  it("supports exactly the two grants the token endpoint implements", () => {
    expect(authorizationServerMetadata().grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ])
    expect(authorizationServerMetadata().response_types_supported).toEqual(["code"])
  })

  it("points every endpoint at the same issuer origin", () => {
    const document = authorizationServerMetadata()
    expect(document.issuer).toBe(ORIGIN)
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      expect(String(document[key]).startsWith(`${ORIGIN}/`)).toBe(true)
    }
  })

  it("byte-matches the issuer clients derive the discovery URL from", () => {
    // Clients MUST validate that the returned issuer equals the issuer they used
    // to build the .well-known URL. No trailing slash, no path.
    const issuer = String(authorizationServerMetadata().issuer)
    expect(issuer).toBe(ORIGIN)
    expect(issuer.endsWith("/")).toBe(false)
    for (const path of AUTHORIZATION_SERVER_METADATA_PATHS) {
      expect(new URL(path, `${issuer}/`).toString()).toBe(`${issuer}${path}`)
    }
  })

  it("follows the deployment origin rather than a hardcoded host", () => {
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("VERCEL_BRANCH_URL", "compass-git-feat-x.vercel.app")
    // VERCEL_BRANCH_URL, not VERCEL_URL: it is stable per branch, so `issuer`
    // does not change under the client's feet between preview deploys.
    expect(authorizationServerMetadata().issuer).toBe("https://compass-git-feat-x.vercel.app")
  })
})

describe("protectedResourceMetadata", () => {
  it("names the canonical MCP resource URI", () => {
    // Must match the URL exactly as a user types it: https, no trailing slash.
    expect(protectedResourceMetadata().resource).toBe(`${ORIGIN}/api/mcp`)
  })

  it("lists the issuer first in authorization_servers", () => {
    // Claude uses only the first entry and does not fall back, so order matters.
    expect(protectedResourceMetadata().authorization_servers).toEqual([ORIGIN])
  })

  it("omits offline_access, which belongs only in the AS document", () => {
    // The spec's "SHOULD NOT advertise offline_access" applies to this file.
    expect(protectedResourceMetadata().scopes_supported).toEqual(["mcp:read", "mcp:write"])
  })

  it("never emits a null value", () => {
    expect(nullishKeys(protectedResourceMetadata())).toEqual([])
  })

  it("declares header-only bearer methods — never a token in a query string", () => {
    expect(protectedResourceMetadata().bearer_methods_supported).toEqual(["header"])
  })

  it("is served at the RFC 9728 path-inserted location the Geode broker derives", () => {
    // discoverOAuthServerInfo falls back to the resource URL, at which point the
    // SDK inserts the resource path. The root document alone is not enough.
    expect(PROTECTED_RESOURCE_METADATA_PATH).toBe("/.well-known/oauth-protected-resource/api/mcp")
    const resource = new URL(String(protectedResourceMetadata().resource))
    expect(PROTECTED_RESOURCE_METADATA_PATH).toBe(
      `/.well-known/oauth-protected-resource${resource.pathname}`,
    )
  })
})
