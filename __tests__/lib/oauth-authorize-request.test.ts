/**
 * The authorize endpoint's request validation, exercised **as the handler uses
 * it** — through a registered client row, not against the pure matcher.
 *
 * `lib/oauth/redirect-uri.ts` already has its own unit tests. What those cannot
 * cover is the wiring: that the authorize path calls `matchRedirectUri` against
 * the client's registered list rather than hand-rolling a comparison, and that a
 * redirect-URI failure is classified `fatal` (show the user) rather than
 * `redirect` (bounce back with an error). Getting that classification backwards
 * is how an authorization endpoint becomes an open redirect, and no test of the
 * matcher alone would catch it.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "../helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import {
  buildAuthorizationErrorUrl,
  buildAuthorizationSuccessUrl,
  resolveScope,
  validateAuthorizationRequest,
} from "@/lib/oauth/authorize-request"

const ORIGIN = "https://compass.example.com"
const CLIENT_ID = "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

async function registerClient(overrides: Record<string, unknown> = {}) {
  await store.oAuthClient.create({
    data: {
      clientId: CLIENT_ID,
      clientName: "Agent Threads",
      // Portless, exactly as the Geode broker registers it.
      redirectUris: ["http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      scope: "mcp:read mcp:write offline_access",
      tokenEndpointAuthMethod: "none",
      ...overrides,
    },
  })
}

function query(overrides: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "http://127.0.0.1:54321/callback",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "abc123",
    scope: "mcp:read mcp:write",
    ...overrides,
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(base)) if (value !== null) params.set(key, value)
  return params
}

beforeEach(() => {
  store.reset()
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
})
afterEach(() => vi.unstubAllEnvs())

describe("redirect_uri, as the authorize handler resolves it", () => {
  it("accepts a fresh ephemeral loopback port against a portless registration", async () => {
    // The Geode broker registers http://127.0.0.1/callback once and then
    // authorizes on whatever port its callback server bound — a different one
    // every time. Exact port matching fails here and only here.
    await registerClient()
    const result = await validateAuthorizationRequest(query())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.redirectUri).toBe("http://127.0.0.1:54321/callback")
  })

  it("accepts a *different* port on a second authorization from the same client", async () => {
    await registerClient()
    const first = await validateAuthorizationRequest(
      query({ redirect_uri: "http://127.0.0.1:49001/callback" }),
    )
    const second = await validateAuthorizationRequest(
      query({ redirect_uri: "http://127.0.0.1:49002/callback" }),
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })

  it("accepts an exact hosted callback", async () => {
    await registerClient({ redirectUris: ["https://claude.ai/api/mcp/auth_callback"] })
    const result = await validateAuthorizationRequest(
      query({ redirect_uri: "https://claude.ai/api/mcp/auth_callback" }),
    )
    expect(result.ok).toBe(true)
  })

  it("never ignores the port for a non-loopback host", async () => {
    await registerClient({ redirectUris: ["https://claude.ai/api/mcp/auth_callback"] })
    const result = await validateAuthorizationRequest(
      query({ redirect_uri: "https://claude.ai:8443/api/mcp/auth_callback" }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("fatal")
  })

  it("rejects an unregistered redirect_uri *without* redirecting to it", async () => {
    await registerClient()
    const result = await validateAuthorizationRequest(
      query({ redirect_uri: "https://evil.example.com/callback" }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    // OAuth 2.1 §4.1.2.1: with no verified redirect_uri there is nowhere safe to
    // send the user. Classifying this as `redirect` would be an open redirect.
    expect(result.kind).toBe("fatal")
  })

  it("rejects a loopback-lookalike host", async () => {
    await registerClient()
    for (const hostile of [
      "http://127.0.0.1.evil.com/callback",
      "http://127.0.0.1@evil.com/callback",
      "http://localhost.evil.com/callback",
    ]) {
      const result = await validateAuthorizationRequest(query({ redirect_uri: hostile }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.kind).toBe("fatal")
    }
  })

  it("rejects a loopback URI whose path differs", async () => {
    await registerClient()
    const result = await validateAuthorizationRequest(
      query({ redirect_uri: "http://127.0.0.1:54321/evil" }),
    )
    expect(result.ok).toBe(false)
  })

  it("defaults to the sole registered URI when the client omits redirect_uri", async () => {
    await registerClient({ redirectUris: ["https://claude.ai/api/mcp/auth_callback"] })
    const result = await validateAuthorizationRequest(query({ redirect_uri: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback")
  })

  it("requires redirect_uri when the client registered more than one", async () => {
    await registerClient({
      redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
    })
    const result = await validateAuthorizationRequest(query({ redirect_uri: null }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("fatal")
  })

  it("rejects a repeated redirect_uri parameter rather than picking one", async () => {
    await registerClient()
    const params = query()
    params.append("redirect_uri", "https://evil.example.com/callback")
    const result = await validateAuthorizationRequest(params)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("fatal")
  })
})

describe("client_id", () => {
  it("is fatal when missing", async () => {
    const result = await validateAuthorizationRequest(query({ client_id: null }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("fatal")
  })

  it("is fatal when unknown", async () => {
    const result = await validateAuthorizationRequest(query())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("fatal")
    expect(result.error).toBe("invalid_client")
  })
})

describe("PKCE at the authorize endpoint", () => {
  beforeEach(registerClient)

  it("rejects a missing code_challenge, and redirects the error back", async () => {
    const result = await validateAuthorizationRequest(query({ code_challenge: null }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The redirect URI is verified by this point, so the client hears about it.
    expect(result.kind).toBe("redirect")
    expect(result.error).toBe("invalid_request")
  })

  it("rejects plain", async () => {
    const result = await validateAuthorizationRequest(query({ code_challenge_method: "plain" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("redirect")
  })

  it("rejects an omitted method, which RFC 7636 defines as plain", async () => {
    const result = await validateAuthorizationRequest(query({ code_challenge_method: null }))
    expect(result.ok).toBe(false)
  })

  it("rejects a challenge that is not a 43-char base64url digest", async () => {
    expect((await validateAuthorizationRequest(query({ code_challenge: "short" }))).ok).toBe(false)
  })
})

describe("response_type", () => {
  beforeEach(registerClient)

  it("rejects anything but code", async () => {
    const result = await validateAuthorizationRequest(query({ response_type: "token" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe("unsupported_response_type")
  })
})

describe("resource, at the authorize endpoint", () => {
  beforeEach(registerClient)

  it("defaults the audience when the client omits it, as Geode and mcp-remote do", async () => {
    const result = await validateAuthorizationRequest(query())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.resource).toBe(`${ORIGIN}/api/mcp`)
  })

  it("rejects a foreign audience", async () => {
    const params = query()
    params.set("resource", "https://evil.example.com/api/mcp")
    const result = await validateAuthorizationRequest(params)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe("invalid_target")
    expect(result.kind).toBe("redirect")
  })
})

describe("scope", () => {
  it("intersects the request with the client's registered scope", () => {
    expect(resolveScope("mcp:read mcp:write", "mcp:read")).toEqual({ ok: true, value: "mcp:read" })
  })

  it("grants the registered scope when the request omits one", () => {
    expect(resolveScope(null, "mcp:read mcp:write")).toEqual({
      ok: true,
      value: "mcp:read mcp:write",
    })
  })

  it("drops unsupported scopes rather than granting them", () => {
    expect(resolveScope("mcp:read admin:everything", "mcp:read mcp:write")).toEqual({
      ok: true,
      value: "mcp:read",
    })
  })

  it("fails when nothing requested is available", () => {
    const result = resolveScope("admin:everything", "mcp:read")
    expect(result.ok).toBe(false)
  })

  it("cannot be widened past what the client registered for", async () => {
    await registerClient({ scope: "mcp:read" })
    const result = await validateAuthorizationRequest(query({ scope: "mcp:read mcp:write" }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.scope).toBe("mcp:read")
  })
})

describe("the authorization response", () => {
  it("carries RFC 9207 iss on success", () => {
    const url = new URL(
      buildAuthorizationSuccessUrl({
        redirectUri: "http://127.0.0.1:54321/callback",
        code: "cmp_oac_" + "a".repeat(32),
        state: "abc123",
      }),
    )
    expect(url.searchParams.get("iss")).toBe(ORIGIN)
    expect(url.searchParams.get("code")).toBe("cmp_oac_" + "a".repeat(32))
    expect(url.searchParams.get("state")).toBe("abc123")
  })

  it("carries iss on an error response too", () => {
    // RFC 9207 §2 covers both. A client that trusts
    // authorization_response_iss_parameter_supported rejects a response without it.
    const url = new URL(
      buildAuthorizationErrorUrl({
        redirectUri: "http://127.0.0.1:54321/callback",
        error: "access_denied",
        description: "The user declined.",
        state: "abc123",
      }),
    )
    expect(url.searchParams.get("iss")).toBe(ORIGIN)
    expect(url.searchParams.get("error")).toBe("access_denied")
    expect(url.searchParams.get("state")).toBe("abc123")
  })

  it("omits state when the client did not send one", () => {
    const url = new URL(
      buildAuthorizationSuccessUrl({
        redirectUri: "http://127.0.0.1:54321/callback",
        code: "c",
        state: null,
      }),
    )
    expect(url.searchParams.has("state")).toBe(false)
  })

  it("preserves a query string already present on the redirect URI", () => {
    const url = new URL(
      buildAuthorizationSuccessUrl({
        redirectUri: "https://claude.ai/cb?tenant=acme",
        code: "c",
        state: null,
      }),
    )
    expect(url.searchParams.get("tenant")).toBe("acme")
    expect(url.searchParams.get("code")).toBe("c")
  })
})
