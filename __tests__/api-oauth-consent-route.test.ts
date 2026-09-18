/**
 * `POST /oauth/consent` — the approve/deny submission.
 *
 * The behaviours worth pinning are the ones a reviewer would want to see proven
 * rather than asserted in a comment: that only an explicit `allow` issues a
 * code, that a forged or cross-user signature issues nothing, that the redirect
 * URI cannot be swapped between the screen and the submit, and that the
 * `__Host-` cookie appears **only** on an approval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "./helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

const session = vi.hoisted(() => ({ value: { user: { id: "user-1", email: "rick@example.com" } } as unknown }))
vi.mock("@/auth", () => ({ auth: async () => session.value }))

import { POST } from "@/app/oauth/consent/route"
import { CONSENT_COOKIE_NAME, signAuthorizationRequest } from "@/lib/oauth/consent"

const ORIGIN = "https://compass.example.com"
const CLIENT_ID = "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const REQUEST = {
  clientId: CLIENT_ID,
  redirectUri: "http://127.0.0.1:54321/callback",
  state: "abc123",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  scope: "mcp:read mcp:write",
  resource: `${ORIGIN}/api/mcp`,
}

function submit(fields: Record<string, string>, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (cookie) headers.cookie = cookie
  return POST(
    new Request(`${ORIGIN}/oauth/consent`, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields).toString(),
    }),
  )
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  await store.oAuthClient.create({
    data: {
      clientId: CLIENT_ID,
      clientName: "Agent Threads",
      redirectUris: ["http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      scope: "mcp:read mcp:write offline_access",
      tokenEndpointAuthMethod: "none",
      ...overrides,
    },
  })
}

beforeEach(async () => {
  store.reset()
  session.value = { user: { id: "user-1", email: "rick@example.com" } }
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
  vi.stubEnv("AUTH_SECRET", "test-signing-secret-value")
  await registerClient()
})
afterEach(() => vi.unstubAllEnvs())

describe("approval", () => {
  it("issues a code and redirects to the client with state and iss", async () => {
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })

    // 303, so the browser follows up with a GET — which is what a loopback
    // callback server is listening for.
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin).toBe("http://127.0.0.1:54321")
    expect(location.searchParams.get("code")).toMatch(/^cmp_oac_[0-9a-f]{32}$/)
    expect(location.searchParams.get("state")).toBe("abc123")
    // RFC 9207 — the AS metadata advertises support, so it must be emitted.
    expect(location.searchParams.get("iss")).toBe(ORIGIN)
  })

  it("binds the code to the signed-in user and the signed request", async () => {
    await submit({ decision: "allow", request: signAuthorizationRequest(REQUEST, "user-1") })

    const [code] = store.oAuthAuthorizationCode.rows
    expect(code.userId).toBe("user-1")
    expect(code.clientId).toBe(CLIENT_ID)
    expect(code.redirectUri).toBe(REQUEST.redirectUri)
    expect(code.codeChallenge).toBe(REQUEST.codeChallenge)
    expect(code.resource).toBe(REQUEST.resource)
  })

  it("records the consent so the next authorization can skip the screen", async () => {
    await submit({ decision: "allow", request: signAuthorizationRequest(REQUEST, "user-1") })
    expect(store.oAuthConsent.rows).toHaveLength(1)
    expect(store.oAuthConsent.rows[0]).toMatchObject({
      userId: "user-1",
      clientId: CLIENT_ID,
      scope: "mcp:read mcp:write",
    })
  })

  it("sets the __Host- consent cookie, Secure and HttpOnly", async () => {
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })
    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toContain(CONSENT_COOKIE_NAME)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).toMatch(/Path=\//i)
  })
})

describe("denial", () => {
  it("redirects back with access_denied and issues nothing", async () => {
    const response = await submit({
      decision: "deny",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })

    const location = new URL(response.headers.get("location")!)
    expect(location.searchParams.get("error")).toBe("access_denied")
    expect(location.searchParams.get("state")).toBe("abc123")
    expect(location.searchParams.get("iss")).toBe(ORIGIN)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    expect(store.oAuthConsent.rows).toHaveLength(0)
  })

  it("treats a missing or unexpected decision as a denial", async () => {
    // A missing field must never be read as approval.
    const cases: Record<string, string>[] = [{}, { decision: "" }, { decision: "yes" }, { decision: "ALLOW" }]
    for (const fields of cases) {
      store.reset()
      await registerClient()
      const response = await submit({
        ...fields,
        request: signAuthorizationRequest(REQUEST, "user-1"),
      })
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("access_denied")
      expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    }
  })

  it("sets no cookie on a denial", async () => {
    const response = await submit({
      decision: "deny",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

describe("CSRF and tampering", () => {
  it("rejects a request signed for a different user", async () => {
    // The blob is bound to session.user.id, so a captured one is worthless and
    // a third-party site cannot mint one at all.
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "someone-else"),
    })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("rejects a missing or forged blob", async () => {
    for (const request of ["", "forged.signature", "not-a-blob"]) {
      const response = await submit({ decision: "allow", request })
      expect(response.status).toBe(400)
    }
    expect((await submit({ decision: "allow" })).status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("cannot have its redirect_uri swapped between the screen and the submit", async () => {
    // The canonical attack: the consent screen shows 127.0.0.1, the POST tries
    // to deliver the code somewhere else. There are no unsigned fields to swap.
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      redirect_uri: "https://evil.example.com/callback",
      client_id: "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      scope: "mcp:read mcp:write offline_access",
    })

    const location = new URL(response.headers.get("location")!)
    expect(location.origin).toBe("http://127.0.0.1:54321")
    expect(store.oAuthAuthorizationCode.rows[0].scope).toBe("mcp:read mcp:write")
  })

  it("rejects an expired request", async () => {
    const stale = signAuthorizationRequest(REQUEST, "user-1", new Date(Date.now() - 60 * 60 * 1000))
    expect((await submit({ decision: "allow", request: stale })).status).toBe(400)
  })

  it("401s without a session", async () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    session.value = null
    const response = await submit({ decision: "allow", request: blob })
    expect(response.status).toBe(401)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })
})

describe("re-validation between render and submit", () => {
  it("refuses when the client was deleted after the screen rendered", async () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    store.oAuthClient.rows = []

    const response = await submit({ decision: "allow", request: blob })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_client")
  })

  it("refuses when the redirect URI was de-registered after the screen rendered", async () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    store.oAuthClient.rows[0].redirectUris = ["https://claude.ai/api/mcp/auth_callback"]

    // A signature proves the request was authentic when rendered, not that it
    // is still authorized now.
    const response = await submit({ decision: "allow", request: blob })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })
})
