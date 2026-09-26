/**
 * Guard tests for the sandbox-facing MCP gateway
 * (app/api/integrations/mcp/[slug]/route.ts, ADR-0018).
 *
 * This route is the only place in Compass that holds a third-party bearer token
 * and points it at somebody else's server, so what is tested here is mostly what
 * it *refuses*: a credential that is not an agent turn, a header it was not asked
 * to forward, a redirect, a second 401. The happy path is covered too, but the
 * assertions on it are about what did **not** cross the boundary.
 *
 * `fetch` is stubbed rather than the `forward()` helper, because the headers on
 * the outbound request are the property under test and a mocked helper would hide
 * them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { McpConnectorError } from "@/lib/mcp-connectors/config"

const mockValidateMcpAuth = vi.fn()
vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: (request: Request) => mockValidateMcpAuth(request),
}))

const mockAvailable = vi.fn()
const mockFindGrant = vi.fn()
vi.mock("@/lib/mcp-connectors/store", () => ({
  mcpConnectorsAvailable: () => mockAvailable(),
  findGrant: (...args: unknown[]) => mockFindGrant(...args),
}))

const mockResolveToken = vi.fn()
const mockRefreshGrant = vi.fn()
vi.mock("@/lib/mcp-connectors/tokens", () => ({
  resolveConnectorToken: (...args: unknown[]) => mockResolveToken(...args),
  refreshGrant: (...args: unknown[]) => mockRefreshGrant(...args),
}))

const { DELETE, GET, POST } = await import("@/app/api/integrations/mcp/[slug]/route")

const connector = {
  id: "connector-1",
  slug: "v0",
  displayName: "v0",
  serverUrl: "https://v0.app/api/mcp",
}

/** The credential the sandbox actually presents: server-minted, short-lived, user-bound. */
const TURN_AUTH = { valid: true, purpose: "AGENT_TURN", userId: "user-1", scopeWorkspaceId: null }

const TOOLS_CALL = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })

function request(
  init: { headers?: Record<string, string>; body?: string; method?: string } = {},
): NextRequest {
  return new NextRequest("https://compass.example/api/integrations/mcp/v0", {
    // The route forwards `request.method` verbatim, so the fixture has to carry the
    // real verb rather than inferring one from the handler that receives it.
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: "Bearer turn-credential",
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body,
  })
}

const params = (slug = "v0") => ({ params: Promise.resolve({ slug }) })

/** Records every outbound call so the forwarded headers can be inspected. */
function stubFetch(...responses: (() => Response)[]) {
  const calls: { url: string; headers: Headers; init: RequestInit }[] = []
  let index = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      calls.push({
        url: input.toString(),
        headers: new Headers(init.headers as HeadersInit),
        init,
      })
      const next = responses[Math.min(index, responses.length - 1)]
      index++
      return next()
    }),
  )
  return calls
}

async function errorBody(response: Response): Promise<{ code: number; message: string }> {
  const body = (await response.json()) as { error: { code: number; message: string } }
  return body.error
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  mockValidateMcpAuth.mockResolvedValue(TURN_AUTH)
  mockAvailable.mockResolvedValue(true)
  mockResolveToken.mockResolvedValue({ connector, accessToken: "v0-access-token" })
})

describe("MCP connector gateway — refusals before any token is spent", () => {
  it("404s an unknown connector without consulting auth or the database", async () => {
    const response = await POST(request({ body: TOOLS_CALL }), params("not-a-connector"))
    expect(response.status).toBe(404)
    expect((await errorBody(response)).code).toBe(-32601)
    // Cheapest check first: nothing else ran.
    expect(mockValidateMcpAuth).not.toHaveBeenCalled()
    expect(mockResolveToken).not.toHaveBeenCalled()
  })

  it.each([
    ["an invalid bearer", { valid: false }],
    ["a static agent key", { valid: true, purpose: "AGENT", userId: "user-1" }],
    ["a service key", { valid: true, purpose: "SERVICE", userId: null }],
    ["an OAuth access token", { valid: true, purpose: "USER", userId: "user-1" }],
    ["a turn credential with no user", { valid: true, purpose: "AGENT_TURN", userId: null }],
  ])("401s %s", async (_label, authResult) => {
    // The exact-match check on `purpose` is what makes this list exhaustive by
    // construction: a new purpose added to `McpAuthResult` lands here, not through.
    mockValidateMcpAuth.mockResolvedValue(authResult)
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(401)
    expect((await errorBody(response)).code).toBe(-32001)
    expect(mockResolveToken).not.toHaveBeenCalled()
  })

  it("503s when migration 062 has not been applied to this deployment", async () => {
    mockAvailable.mockResolvedValue(false)
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(503)
    expect((await errorBody(response)).code).toBe(-32002)
  })

  it("413s an oversized body instead of streaming it to the provider", async () => {
    const response = await POST(
      request({ body: "x".repeat(1024 * 1024 + 1) }),
      params(),
    )
    expect(response.status).toBe(413)
    expect((await errorBody(response)).code).toBe(-32003)
  })

  it("tells the agent how to fix a missing connection rather than failing opaquely", async () => {
    mockResolveToken.mockResolvedValue(null)
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(403)
    const error = await errorBody(response)
    expect(error.code).toBe(-32004)
    // The body is what reaches the model, so it carries the instruction.
    expect(error.message).toContain("Settings → My agents")
    expect(error.message).toContain("v0")
  })

  it("resolves the grant from the credential's own user, never from the request", async () => {
    stubFetch(() => new Response("{}", { status: 200 }))
    await POST(
      request({ body: TOOLS_CALL, headers: { "x-compass-user-id": "victim-user" } }),
      params(),
    )
    expect(mockResolveToken).toHaveBeenCalledWith("v0", expect.any(String), "user-1")
  })
})

describe("MCP connector gateway — forwarding", () => {
  it("attaches the provider bearer and forwards only allowlisted headers", async () => {
    const calls = stubFetch(
      () =>
        new Response('{"jsonrpc":"2.0"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-9",
            // Neither of these may reach the sandbox: one would send the agent SDK
            // off doing OAuth against a Compass path, the other would put a v0
            // cookie in the microVM.
            "www-authenticate": 'Bearer resource_metadata="https://v0.app/.well-known/x"',
            "set-cookie": "v0_session=abc",
          },
        }),
    )

    const response = await POST(
      request({
        body: TOOLS_CALL,
        headers: {
          "mcp-session-id": "session-9",
          "mcp-protocol-version": "2025-06-18",
          cookie: "compass_session=abc",
          "x-vercel-protection-bypass": "a-live-secret",
          "user-agent": "claude-agent-sdk/1",
        },
      }),
      params(),
    )

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://v0.app/api/mcp")
    expect(calls[0].init.redirect).toBe("manual")

    // The one header the gateway adds, and the one that must be the *provider's*
    // token rather than the turn credential the sandbox presented.
    expect(calls[0].headers.get("authorization")).toBe("Bearer v0-access-token")
    expect(calls[0].headers.get("authorization")).not.toContain("turn-credential")
    // Closed allowlist, not "everything except Authorization": these are live
    // secrets and a live Compass session.
    expect(calls[0].headers.get("cookie")).toBeNull()
    expect(calls[0].headers.get("x-vercel-protection-bypass")).toBeNull()
    expect(calls[0].headers.get("user-agent")).toBeNull()
    // Transport headers do pass, or the streamable-HTTP session breaks.
    expect(calls[0].headers.get("mcp-session-id")).toBe("session-9")
    expect(calls[0].headers.get("mcp-protocol-version")).toBe("2025-06-18")

    expect(response.headers.get("mcp-session-id")).toBe("session-9")
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("proxies the GET that opens the server→client stream", async () => {
    const calls = stubFetch(
      () =>
        new Response("event: message\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const response = await GET(request({ headers: { accept: "text/event-stream" } }), params())
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(calls[0].init.method).toBe("GET")
    // No body invented for a GET: `fetch` rejects one outright.
    expect(calls[0].init.body).toBeUndefined()
    // Streamed through, not buffered — an SSE response has no end until the
    // provider closes it.
    expect(await response.text()).toContain("event: message")
  })

  it("proxies the DELETE that terminates the session", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }))
    const response = await DELETE(
      request({ method: "DELETE", headers: { "mcp-session-id": "session-9" } }),
      params(),
    )
    expect(response.status).toBe(204)
    expect(calls[0].init.method).toBe("DELETE")
  })

  it("passes a provider error status through instead of flattening it to 200", async () => {
    stubFetch(() => new Response('{"error":"bad request"}', { status: 400 }))
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(400)
  })

  it("refuses a redirect on the MCP endpoint rather than carrying the bearer to it", async () => {
    const calls = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    )
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(502)
    expect((await errorBody(response)).code).toBe(-32006)
    // Not followed: one call, and no request ever reached the redirect target.
    expect(calls).toHaveLength(1)
    expect(calls.map(call => call.url)).not.toContain("https://evil.example/")
  })

  it("returns the error code but not the provider's response text", async () => {
    mockResolveToken.mockRejectedValue(
      new McpConnectorError("REFRESH_FAILED", 'v0 said {"error":"leak me"}'),
    )
    vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(502)
    const error = await errorBody(response)
    expect(error.message).toContain("REFRESH_FAILED")
    // The message can quote a provider body, so it is logged rather than returned.
    expect(error.message).not.toContain("leak me")
  })
})

describe("MCP connector gateway — the single 401 retry", () => {
  it("refreshes once and replays the buffered body", async () => {
    // A provider can revoke early, before the `expires_at` Compass recorded, so a
    // 401 here does not mean the stored expiry was wrong.
    const calls = stubFetch(
      () => new Response("unauthorized", { status: 401 }),
      () => new Response('{"jsonrpc":"2.0"}', { status: 200 }),
    )
    mockFindGrant.mockResolvedValue({ id: "grant-1", generation: 1 })
    mockRefreshGrant.mockResolvedValue("refreshed-token")

    const response = await POST(request({ body: TOOLS_CALL }), params())

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[0].headers.get("authorization")).toBe("Bearer v0-access-token")
    expect(calls[1].headers.get("authorization")).toBe("Bearer refreshed-token")
    // The body was buffered up front precisely so the replay is a real replay.
    expect(calls[1].init.body).toBeDefined()
    expect(mockRefreshGrant).toHaveBeenCalledTimes(1)
  })

  it("stops after the second 401 instead of looping on refresh tokens", async () => {
    const calls = stubFetch(() => new Response("unauthorized", { status: 401 }))
    mockFindGrant.mockResolvedValue({ id: "grant-1", generation: 1 })
    mockRefreshGrant.mockResolvedValue("refreshed-token")

    const response = await POST(request({ body: TOOLS_CALL }), params())

    expect(response.status).toBe(502)
    const error = await errorBody(response)
    expect(error.code).toBe(-32005)
    expect(error.message).toContain("Reconnect it")
    // Exactly two: the second 401 is the provider saying the grant is gone, and a
    // loop would spend rotating refresh tokens against a wall.
    expect(calls).toHaveLength(2)
    expect(mockRefreshGrant).toHaveBeenCalledTimes(1)
  })

  it("reports a grant disconnected mid-turn as a missing connection", async () => {
    stubFetch(() => new Response("unauthorized", { status: 401 }))
    mockFindGrant.mockResolvedValue(null)

    const response = await POST(request({ body: TOOLS_CALL }), params())

    expect(response.status).toBe(403)
    expect((await errorBody(response)).code).toBe(-32004)
    expect(mockRefreshGrant).not.toHaveBeenCalled()
  })

  it("does not retry a 403, which is the provider's answer about scope not staleness", async () => {
    const calls = stubFetch(() => new Response("forbidden", { status: 403 }))
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(1)
    expect(mockRefreshGrant).not.toHaveBeenCalled()
  })
})

/**
 * A timeout is a *truthfulness* bug, not just a latency one.
 *
 * The first real v0 turn was aborted here at 55 s, the agent read the resulting
 * `GATEWAY_FAILED` as "v0 is unreachable", and told the user to go rebuild by hand
 * an app v0 had already finished building. So what is asserted below is the
 * content of the message as much as the code: the agent must be told the work may
 * have completed, and told to check before acting.
 *
 * The fixture's error shape is the real one — verified in Node 22 that a `fetch`
 * aborted by `AbortSignal.timeout` rejects with a `DOMException` named
 * `TimeoutError` that is `instanceof Error`, which is exactly what the route
 * discriminates on.
 */
describe("MCP connector gateway — a lost response is not a failed call", () => {
  const timeoutError = () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("504s a timed-out call under its own code rather than the generic failure", async () => {
    stubFetch(timeoutError)
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(504)
    expect((await errorBody(response)).code).toBe(-32007)
  })

  it("tells the agent the work may have completed, and to look before retrying", async () => {
    stubFetch(timeoutError)
    const { message } = await errorBody(await POST(request({ body: TOOLS_CALL }), params()))

    // The three instructions that stop the reported bug recurring.
    expect(message).toContain("may have completed")
    expect(message).toContain("check for the result before doing anything again")
    expect(message).toContain("Do not tell the user it failed until you have checked")
    // And it names the provider, since the agent may hold several connectors.
    expect(message).toContain("v0")
    // Must not read as a failure report about the provider — that framing is the bug.
    expect(message).not.toContain("connection failed")
  })

  it("still reports a genuinely unreachable provider as a failure", async () => {
    // The opposite case, and the reason the two codes are separate: here nothing
    // happened at the provider, so "go and check" would be wrong advice.
    stubFetch(() => {
      throw new TypeError("fetch failed")
    })
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(502)
    const error = await errorBody(response)
    expect(error.code).toBe(-32006)
    expect(error.message).toContain("GATEWAY_FAILED")
  })

  it("does not mistake a non-timeout abort for a timeout", async () => {
    // `AbortError` is what a caller-cancelled request rejects with; only
    // `TimeoutError` means the clock ran out. Discriminating on the name rather
    // than on "is this an abort" is what keeps these apart.
    stubFetch(() => {
      throw new DOMException("This operation was aborted", "AbortError")
    })
    const response = await POST(request({ body: TOOLS_CALL }), params())
    expect(response.status).toBe(502)
    expect((await errorBody(response)).code).toBe(-32006)
  })

  it("bounds the wait it reports on with the constant that enforces it", async () => {
    // Guards against the message drifting from the real ceiling if the constant
    // moves — the number the agent is told is the number the route used.
    const { GATEWAY_TIMEOUT_MS } = await import("@/lib/mcp-connectors/gateway")
    stubFetch(timeoutError)
    const { message } = await errorBody(await POST(request({ body: TOOLS_CALL }), params()))
    expect(message).toContain(`${Math.round(GATEWAY_TIMEOUT_MS / 1000)}s`)
  })
})
