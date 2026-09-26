/**
 * Guard tests for the two browser-facing connector routes (ADR-0018):
 * `app/api/connectors/[slug]/connect` and `.../callback`.
 *
 * The callback is where a grant is actually created, so it is where the security
 * checks are. The one that cannot be skipped is the ownership comparison: an
 * attacker completes their *own* consent at v0, hands the resulting callback URL
 * to a victim, and without that check the victim's Compass account silently ends
 * up driving the attacker's v0 account. A session exists and the `state` is
 * genuine in that scenario — only comparing the two catches it, which is why it
 * gets its own test rather than living inside a happy-path assertion.
 *
 * The connect route's own tests are mostly about what it does *not* take from the
 * request: the origin is the deployment's, not a header, because `redirect_uri` is
 * matched by exact string at the provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { McpConnectorError } from "@/lib/mcp-connectors/config"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockAvailable = vi.fn()
const mockEnsureConnector = vi.fn()
const mockCreateAuthRequest = vi.fn()
const mockConsumeAuthRequest = vi.fn()
const mockFindConnector = vi.fn()
const mockSaveGrant = vi.fn()
const mockPrune = vi.fn()
vi.mock("@/lib/mcp-connectors/store", () => ({
  mcpConnectorsAvailable: () => mockAvailable(),
  ensureConnector: (...args: unknown[]) => mockEnsureConnector(...args),
  createAuthRequest: (...args: unknown[]) => mockCreateAuthRequest(...args),
  consumeAuthRequest: (...args: unknown[]) => mockConsumeAuthRequest(...args),
  findConnector: (...args: unknown[]) => mockFindConnector(...args),
  saveGrant: (...args: unknown[]) => mockSaveGrant(...args),
  pruneExpiredAuthRequests: () => mockPrune(),
}))

const mockExchange = vi.fn()
vi.mock("@/lib/mcp-connectors/tokens", async () => {
  // `buildAuthorizeUrl` is the real implementation: the connect route's job is to
  // produce a correct authorization URL, and a stubbed builder would assert nothing
  // about it.
  const actual = await vi.importActual<typeof import("@/lib/mcp-connectors/tokens")>(
    "@/lib/mcp-connectors/tokens",
  )
  return { ...actual, exchangeAuthorizationCode: (...args: unknown[]) => mockExchange(...args) }
})

const { GET: connect } = await import("@/app/api/connectors/[slug]/connect/route")
const { GET: callback } = await import("@/app/api/connectors/[slug]/callback/route")

const connector = {
  id: "connector-1",
  slug: "v0",
  origin: "http://localhost:3000",
  displayName: "v0",
  serverUrl: "https://v0.app/api/mcp",
  resource: "https://v0.app/api/mcp",
  authorizationEndpoint: "https://v0.app/oauth/authorize",
  tokenEndpoint: "https://v0.app/oauth/token",
  revocationEndpoint: null,
  scope: "mcp",
  clientId: "client-abc",
  enabled: true,
}

/** What `consumeAuthRequest` hands back once it has claimed a pending row. */
const authRequest = {
  id: "auth-1",
  connectorId: connector.id,
  userId: "user-1",
  codeVerifier: "verifier-value",
  redirectUri: "http://localhost:3000/api/connectors/v0/callback",
  returnTo: "/settings/agents",
}

const params = (slug = "v0") => ({ params: Promise.resolve({ slug }) })

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { method: "GET" })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("MCP_CONNECTOR_SECRET_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"))
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockAvailable.mockResolvedValue(true)
  mockEnsureConnector.mockResolvedValue(connector)
  mockCreateAuthRequest.mockResolvedValue({ state: "state-abc", codeVerifier: "verifier-value" })
  mockConsumeAuthRequest.mockResolvedValue(authRequest)
  mockFindConnector.mockResolvedValue(connector)
  mockPrune.mockResolvedValue(undefined)
  mockExchange.mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresAt: null,
    scope: "mcp",
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("connect route", () => {
  it("redirects to the provider with a state it minted for this user", async () => {
    const response = await connect(get("/api/connectors/v0/connect"), params())

    expect(response.status).toBe(307)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin + location.pathname).toBe("https://v0.app/oauth/authorize")
    expect(location.searchParams.get("state")).toBe("state-abc")
    expect(location.searchParams.get("resource")).toBe(connector.resource)
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    // The verifier stays server-side; only its hash is shown to the provider.
    expect(response.headers.get("location")).not.toContain("verifier-value")
    // No-store, so a back-navigation re-enters the route and mints fresh state
    // rather than replaying a consumed one out of the browser cache.
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockCreateAuthRequest).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", connectorId: connector.id }),
    )
  })

  it("keys the connector on the deployment's own origin, not a forwarded header", async () => {
    const spoofed = new NextRequest("http://localhost:3000/api/connectors/v0/connect", {
      method: "GET",
      headers: { "x-forwarded-host": "evil.example", host: "evil.example" },
    })
    await connect(spoofed, params())
    // A header-derived origin would let a spoofed request register an OAuth client
    // for a redirect_uri Compass does not own.
    expect(mockEnsureConnector).toHaveBeenCalledWith(
      "v0",
      "http://localhost:3000",
      "http://localhost:3000/api/connectors/v0/callback",
    )
  })

  it("degrades a hostile returnTo to the default page instead of failing", async () => {
    await connect(get("/api/connectors/v0/connect?returnTo=https://evil.example/steal"), params())
    expect(mockCreateAuthRequest).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/settings/agents" }),
    )
  })

  it("keeps a legitimate returnTo", async () => {
    await connect(get("/api/connectors/v0/connect?returnTo=%2Fsettings%2Fagents%3Ftab%3Dmcp"), params())
    expect(mockCreateAuthRequest).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/settings/agents?tab=mcp" }),
    )
  })

  it("401s a signed-out visitor and 404s an unknown connector", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await connect(get("/api/connectors/v0/connect"), params())).status).toBe(401)

    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
    expect(
      (await connect(get("/api/connectors/nope/connect"), params("nope"))).status,
    ).toBe(404)
    expect(mockEnsureConnector).not.toHaveBeenCalled()
  })

  it("503s before migration 062 is applied, and names the migration", async () => {
    mockAvailable.mockResolvedValue(false)
    const response = await connect(get("/api/connectors/v0/connect"), params())
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain("062_mcp_connectors")
  })

  it("surfaces a discovery or registration failure as a 502 with its code", async () => {
    mockEnsureConnector.mockRejectedValue(
      new McpConnectorError("REGISTRATION_FAILED", "v0 refused the registration"),
    )
    const response = await connect(get("/api/connectors/v0/connect"), params())
    expect(response.status).toBe(502)
    expect((await response.json()).code).toBe("REGISTRATION_FAILED")
  })

  it("does not let the opportunistic prune fail the connect", async () => {
    mockPrune.mockRejectedValue(new Error("DSQL hiccup"))
    const response = await connect(get("/api/connectors/v0/connect"), params())
    expect(response.status).toBe(307)
  })
})

describe("callback route", () => {
  function callbackUrl(query: string): NextRequest {
    return get(`/api/connectors/v0/callback?${query}`)
  }

  function noticeParams(response: Response): URLSearchParams {
    return new URL(response.headers.get("location") ?? "", "http://localhost:3000").searchParams
  }

  it("saves the grant and redirects back with a success notice", async () => {
    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())

    expect(response.status).toBe(307)
    const url = new URL(response.headers.get("location") ?? "")
    expect(url.pathname).toBe("/settings/agents")
    expect(url.searchParams.get("connector")).toBe("v0")
    expect(url.searchParams.get("connected")).toBe("1")

    expect(mockSaveGrant).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: connector.id, userId: "user-1", accessToken: "at" }),
    )
    // The redirect_uri comes off the stored row so it byte-matches what the
    // authorization endpoint saw; rebuilding it here would be attacker-influenced.
    expect(mockExchange).toHaveBeenCalledWith(
      connector,
      expect.objectContaining({ code: "code-1", redirectUri: authRequest.redirectUri }),
    )
  })

  it("refuses a callback that arrives under a different user than it was issued to", async () => {
    // The login-CSRF check. Steps 1 and 2 both pass here — the session is real and
    // the state is genuine — so only the ownership comparison stops it.
    mockAuth.mockResolvedValue({ user: { id: "victim-user" } })

    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())

    expect(noticeParams(response).get("connectorError")).toBe("WRONG_USER")
    // Nothing was granted, and the authorization code was never redeemed.
    expect(mockExchange).not.toHaveBeenCalled()
    expect(mockSaveGrant).not.toHaveBeenCalled()
  })

  it("refuses a state redeemed against a different connector's token endpoint", async () => {
    mockFindConnector.mockResolvedValue({ ...connector, id: "some-other-connector" })
    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())
    expect(noticeParams(response).get("connectorError")).toBe("CONNECTOR_MISMATCH")
    // Otherwise the code — and the PKCE verifier with it — would go to the wrong
    // provider.
    expect(mockExchange).not.toHaveBeenCalled()
  })

  it("401s a signed-out visitor rather than sending them round the login loop", async () => {
    // The single-use state has already been spent at the provider by this point, so
    // a /login redirect would only land them back on a dead callback.
    mockAuth.mockResolvedValue(null)
    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())
    expect(response.status).toBe(401)
    expect(response.headers.get("location")).toBeNull()
    expect(mockConsumeAuthRequest).not.toHaveBeenCalled()
  })

  it("reports a replayed or expired state without redeeming anything", async () => {
    mockConsumeAuthRequest.mockRejectedValue(new McpConnectorError("INVALID_AUTH_REQUEST"))
    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())
    expect(noticeParams(response).get("connectorError")).toBe("INVALID_AUTH_REQUEST")
    expect(mockSaveGrant).not.toHaveBeenCalled()
  })

  it("reports a missing code or state as MISSING_PARAMETERS", async () => {
    expect(noticeParams(await callback(callbackUrl("state=state-abc"), params())).get("connectorError")).toBe(
      "MISSING_PARAMETERS",
    )
    expect(noticeParams(await callback(callbackUrl("code=code-1"), params())).get("connectorError")).toBe(
      "MISSING_PARAMETERS",
    )
    expect(mockConsumeAuthRequest).not.toHaveBeenCalled()
  })

  it("passes a provider error code through but clamps anything outside the OAuth charset", async () => {
    expect(
      noticeParams(await callback(callbackUrl("error=access_denied"), params())).get("connectorError"),
    ).toBe("access_denied")
    // A hostile code would otherwise be reflected into the page.
    expect(
      noticeParams(
        await callback(callbackUrl("error=" + encodeURIComponent("<script>alert(1)</script>")), params()),
      ).get("connectorError"),
    ).toBe("AUTHORIZATION_FAILED")
    // Nothing is cleaned up on a refusal: deleting the pending row here would let
    // an unauthenticated guess at a state value cancel somebody's live flow.
    expect(mockConsumeAuthRequest).not.toHaveBeenCalled()
  })

  it("does not reflect a provider's response text into the URL on a token failure", async () => {
    mockExchange.mockRejectedValue(
      new McpConnectorError("TOKEN_EXCHANGE_FAILED", 'v0 said {"error":"leak me"}'),
    )
    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())
    const location = response.headers.get("location") ?? ""
    expect(noticeParams(response).get("connectorError")).toBe("TOKEN_EXCHANGE_FAILED")
    expect(location).not.toContain("leak me")
  })

  it("re-validates returnTo on the way out, because storage is not a trust boundary", async () => {
    mockConsumeAuthRequest.mockResolvedValue({ ...authRequest, returnTo: "https://evil.example/steal" })
    const response = await callback(callbackUrl("state=state-abc&code=code-1"), params())
    const url = new URL(response.headers.get("location") ?? "")
    expect(url.origin).toBe("http://localhost:3000")
    expect(url.pathname).toBe("/settings/agents")
  })

  it("404s an unknown connector and 503s before the migration is applied", async () => {
    expect((await callback(callbackUrl("state=s&code=c"), params("nope"))).status).toBe(404)
    mockAvailable.mockResolvedValue(false)
    expect((await callback(callbackUrl("state=s&code=c"), params())).status).toBe(503)
    expect(mockConsumeAuthRequest).not.toHaveBeenCalled()
  })
})
