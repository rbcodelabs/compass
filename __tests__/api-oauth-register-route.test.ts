/**
 * `POST /api/oauth/register` — RFC 7591 dynamic client registration.
 *
 * The two registrations that *must* work are the ones a real client sends, so
 * they lead: a public client (`token_endpoint_auth_method: "none"`) and a
 * **portless** `http://127.0.0.1/callback`. Both are exactly what the Geode
 * broker posts, and either being rejected takes the primary consumer offline
 * before a user ever sees a consent screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "./helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import { POST } from "@/app/api/oauth/register/route"
import { resetRegistrationRateLimit } from "@/lib/oauth/rate-limit"

const ORIGIN = "https://compass.example.com"

function register(body: unknown, ip = "203.0.113.10") {
  return POST(
    new Request(`${ORIGIN}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )
}

/** Exactly what Geode's OAuthMcpRegistry posts. */
const GEODE_REGISTRATION = {
  client_name: "Agent Threads",
  redirect_uris: ["http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
}

beforeEach(() => {
  store.reset()
  resetRegistrationRateLimit()
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
})
afterEach(() => vi.unstubAllEnvs())

describe("the Geode broker's registration", () => {
  it("is accepted verbatim", async () => {
    const response = await register(GEODE_REGISTRATION)
    expect(response.status).toBe(201)

    const body = await response.json()
    expect(body.client_id).toMatch(/^cmp_oc_[0-9a-f]{32}$/)
    expect(body.token_endpoint_auth_method).toBe("none")
    expect(body.redirect_uris).toEqual(["http://127.0.0.1/callback"])
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"])
    // A public client gets no secret, and must not be handed one it cannot hold.
    expect("client_secret" in body).toBe(false)
  })

  it("stores the arrays in the Json columns, readable back as arrays", async () => {
    await register(GEODE_REGISTRATION)
    const [row] = store.oAuthClient.rows
    expect(row.redirectUris).toEqual(["http://127.0.0.1/callback"])
    expect(row.grantTypes).toEqual(["authorization_code", "refresh_token"])
    expect(row.clientSecretHash).toBeNull()
  })

  it("is never cached", async () => {
    const response = await register(GEODE_REGISTRATION)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("redirect_uris", () => {
  const withUris = (uris: unknown) => register({ ...GEODE_REGISTRATION, redirect_uris: uris })

  it("accepts a portless loopback URI", async () => {
    expect((await withUris(["http://127.0.0.1/callback"])).status).toBe(201)
    expect((await withUris(["http://localhost/callback"])).status).toBe(201)
  })

  it("accepts a loopback URI that does carry a port", async () => {
    expect((await withUris(["http://127.0.0.1:8765/callback"])).status).toBe(201)
  })

  it("accepts an https hosted callback", async () => {
    expect((await withUris(["https://claude.ai/api/mcp/auth_callback"])).status).toBe(201)
  })

  it("accepts Claude Code's pair of loopback spellings", async () => {
    const response = await withUris(["http://localhost/callback", "http://127.0.0.1/callback"])
    expect(response.status).toBe(201)
  })

  it("rejects plain http to a non-loopback host", async () => {
    // An authorization code in cleartext across the network.
    const response = await withUris(["http://evil.example.com/callback"])
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_redirect_uri")
  })

  it("rejects a loopback-lookalike host", async () => {
    for (const hostile of ["http://127.0.0.1.evil.com/cb", "http://127.0.0.1@evil.com/cb"]) {
      expect((await withUris([hostile])).status).toBe(400)
    }
  })

  it("rejects a private-use scheme", async () => {
    // RFC 8252 permits one, but no client Compass targets uses a custom scheme
    // and an unclaimed scheme is hijackable by any app on the device.
    expect((await withUris(["myapp://callback"])).status).toBe(400)
  })

  it("rejects a fragment, which RFC 6749 §3.1.2 forbids", async () => {
    expect((await withUris(["https://claude.ai/cb#frag"])).status).toBe(400)
  })

  it("rejects an empty or missing list", async () => {
    expect((await withUris([])).status).toBe(400)
    const missing = await register({ client_name: "No URIs" })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe("invalid_redirect_uri")
  })

  it("rejects a non-string entry", async () => {
    expect((await withUris([{ url: "https://claude.ai/cb" }])).status).toBe(400)
  })

  it("caps how many may be registered", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`)
    expect((await withUris(many)).status).toBe(400)
  })

  it("de-duplicates", async () => {
    const response = await withUris(["https://claude.ai/cb", "https://claude.ai/cb"])
    expect((await response.json()).redirect_uris).toEqual(["https://claude.ai/cb"])
  })
})

describe("client metadata", () => {
  it("defaults response_types, grant_types and auth method when omitted", async () => {
    const body = await (
      await register({ client_name: "Minimal", redirect_uris: ["https://claude.ai/cb"] })
    ).json()
    expect(body.response_types).toEqual(["code"])
    expect(body.grant_types).toEqual(["authorization_code"])
    expect(body.token_endpoint_auth_method).toBe("none")
  })

  it("implies authorization_code when a client asks only for refresh_token", async () => {
    // A client registered for refresh_token alone could never obtain the refresh
    // token it wants to use.
    const body = await (
      await register({ ...GEODE_REGISTRATION, grant_types: ["refresh_token"] })
    ).json()
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"])
  })

  it("rejects an unsupported grant or response type", async () => {
    expect((await register({ ...GEODE_REGISTRATION, grant_types: ["password"] })).status).toBe(400)
    expect((await register({ ...GEODE_REGISTRATION, response_types: ["token"] })).status).toBe(400)
  })

  it("rejects an unsupported token_endpoint_auth_method", async () => {
    const response = await register({
      ...GEODE_REGISTRATION,
      token_endpoint_auth_method: "client_secret_basic",
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_client_metadata")
  })

  it("issues a secret only for client_secret_post", async () => {
    const body = await (
      await register({ ...GEODE_REGISTRATION, token_endpoint_auth_method: "client_secret_post" })
    ).json()
    expect(body.client_secret).toMatch(/^cmp_ocs_[0-9a-f]{32}$/)
    expect(body.client_secret_expires_at).toBe(0)
    // Stored as a hash, never in the clear.
    expect(store.oAuthClient.rows[0].clientSecretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(store.oAuthClient.rows)).not.toContain(body.client_secret)
  })

  it("grants every supported scope when none is requested", async () => {
    const body = await (await register(GEODE_REGISTRATION)).json()
    expect(body.scope).toBe("mcp:read mcp:write offline_access")
  })

  it("drops unsupported scopes and echoes what was actually granted", async () => {
    const body = await (
      await register({ ...GEODE_REGISTRATION, scope: "mcp:read admin:everything" })
    ).json()
    expect(body.scope).toBe("mcp:read")
  })

  it("rejects a request for no supported scope at all", async () => {
    expect((await register({ ...GEODE_REGISTRATION, scope: "admin:everything" })).status).toBe(400)
  })

  it("ignores extension metadata rather than rejecting it", async () => {
    // RFC 7591 §2 explicitly permits it, and clients do send fields we ignore.
    const response = await register({
      ...GEODE_REGISTRATION,
      software_version: "1.2.3",
      contacts: ["ops@example.com"],
      tos_uri: "https://example.com/tos",
    })
    expect(response.status).toBe(201)
  })

  it("drops a non-https logo_uri or client_uri instead of rendering it", async () => {
    // These are shown on the consent screen; a javascript: or data: URI there
    // would be stored XSS on the one page where a user grants access.
    const body = await (
      await register({
        ...GEODE_REGISTRATION,
        logo_uri: "javascript:alert(1)",
        client_uri: "http://evil.example.com",
      })
    ).json()
    expect("logo_uri" in body).toBe(false)
    expect("client_uri" in body).toBe(false)
  })

  it("falls back to a placeholder name rather than failing", async () => {
    const body = await (await register({ redirect_uris: ["https://claude.ai/cb"] })).json()
    expect(body.client_name).toBe("Unnamed client")
  })
})

describe("hardening", () => {
  it("rejects a non-JSON body", async () => {
    const response = await register("not json at all")
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_client_metadata")
  })

  it("rejects a JSON array or scalar", async () => {
    expect((await register([1, 2, 3])).status).toBe(400)
    expect((await register("42")).status).toBe(400)
  })

  it("rate-limits per IP, and counts failed attempts too", async () => {
    // Counting only successes would let an attacker probe validation for free.
    for (let i = 0; i < 10; i += 1) await register({ redirect_uris: [] }, "198.51.100.7")

    const blocked = await register(GEODE_REGISTRATION, "198.51.100.7")
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("keeps separate buckets per address", async () => {
    for (let i = 0; i < 10; i += 1) await register(GEODE_REGISTRATION, "198.51.100.7")
    expect((await register(GEODE_REGISTRATION, "198.51.100.8")).status).toBe(201)
  })

  it("does not issue a registration_access_token it has no endpoint for", async () => {
    const body = await (await register(GEODE_REGISTRATION)).json()
    // RFC 7592 client management is not implemented; handing out a credential
    // for an endpoint that does not exist is worse than omitting both.
    expect("registration_access_token" in body).toBe(false)
    expect("registration_client_uri" in body).toBe(false)
  })

  it("allows cross-origin browser clients", async () => {
    const response = await register(GEODE_REGISTRATION)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })
})
