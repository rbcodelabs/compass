/**
 * Guard tests for the agent-only web_fetch MCP route
 * (app/api/agent/web-fetch/[transport]/route.ts).
 *
 * What matters is what it refuses: anything that is not a server-minted AGENT_TURN
 * API-key credential gets a 401 before any outbound request is made, and the tool runs
 * bound to the credential's own identity, never the request's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockValidateMcpAuth = vi.fn()
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: (request: Request) => mockValidateMcpAuth(request) }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))

const mockRunWebFetch = vi.fn()
vi.mock("@/lib/agent-web-fetch", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/agent-web-fetch")>()),
  runWebFetch: (...args: unknown[]) => mockRunWebFetch(...args),
}))

const { POST, GET, DELETE } = await import("@/app/api/agent/web-fetch/[transport]/route")

const CREDENTIAL = "22222222-2222-4222-8222-222222222222"
const TURN_AUTH = {
  valid: true,
  purpose: "AGENT_TURN",
  userId: "user-1",
  scopeWorkspaceId: "ws-1",
  scopeConversationId: null,
  credentialId: CREDENTIAL,
  credentialType: "API_KEY",
}

const rpc = (body: unknown) =>
  new Request("https://compass.example/api/agent/web-fetch/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer turn-credential",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  })
const call = (args: unknown) => rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_fetch", arguments: args } })
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" }

beforeEach(() => {
  mockValidateMcpAuth.mockReset().mockResolvedValue(TURN_AUTH)
  mockRunWebFetch.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("web_fetch route gating", () => {
  it.each([
    ["an invalid credential", { valid: false }],
    ["a static user key", { ...TURN_AUTH, purpose: "USER" }],
    ["an OAuth access token", { ...TURN_AUTH, purpose: "OAUTH", credentialType: "OAUTH_TOKEN" }],
    ["a turn credential without a user", { ...TURN_AUTH, userId: null }],
    ["a turn credential without a workspace", { ...TURN_AUTH, scopeWorkspaceId: null }],
    ["a credential that is not an API key row", { ...TURN_AUTH, credentialType: "OAUTH_TOKEN" }],
    ["a credential id that is not a uuid", { ...TURN_AUTH, credentialId: "not-a-uuid" }],
    ["a missing credential id", { ...TURN_AUTH, credentialId: undefined }],
  ])("rejects %s with a JSON-RPC 401 and never fetches", async (_label, auth) => {
    mockValidateMcpAuth.mockResolvedValue(auth)
    for (const handler of [POST, GET, DELETE]) {
      const response = await handler(call({ url: "https://example.com/" }))
      expect(response.status).toBe(401)
      expect((await response.json()).error.code).toBe(-32001)
    }
    expect(mockRunWebFetch).not.toHaveBeenCalled()
  })

  it("rejects a request with no Authorization at all", async () => {
    mockValidateMcpAuth.mockResolvedValue({ valid: false })
    const response = await POST(new Request("https://compass.example/api/agent/web-fetch/mcp", { method: "POST", body: "{}" }))
    expect(response.status).toBe(401)
    expect(mockRunWebFetch).not.toHaveBeenCalled()
  })
})

describe("web_fetch route tool", () => {
  it("exposes exactly one tool, web_fetch, with url and max_chars", async () => {
    const response = await POST(rpc(LIST))
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"web_fetch"')
    expect((text.match(/"name":/g) ?? []).length).toBe(1)
    expect(text).toContain('"url"')
    expect(text).toContain('"max_chars"')
  })

  it("runs the fetch bound to the credential's own identity, never the request's", async () => {
    mockRunWebFetch.mockResolvedValue({
      status: "ok",
      remaining: 9,
      page: { url: "https://e.test/", finalUrl: "https://e.test/", status: 200, contentType: "text/plain", title: "", text: "page text", totalChars: 9, truncated: false, redirects: 0, bytes: 9 },
    })
    const response = await POST(call({ url: "https://e.test/", max_chars: 500 }))
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("page text")
    expect(text).toContain("untrusted third-party data")
    expect(mockRunWebFetch).toHaveBeenCalledWith(
      expect.anything(),
      { credentialId: CREDENTIAL, userId: "user-1", workspaceId: "ws-1", conversationId: null },
      { url: "https://e.test/", maxChars: 500 },
    )
  })

  it("takes the conversation from the credential and ignores anything that is not a uuid", async () => {
    const conversation = "33333333-3333-4333-8333-333333333333"
    mockRunWebFetch.mockResolvedValue({ status: "budget_exhausted" })
    mockValidateMcpAuth.mockResolvedValue({ ...TURN_AUTH, scopeConversationId: conversation })
    await POST(call({ url: "https://e.test/" }))
    expect(mockRunWebFetch.mock.calls[0][1].conversationId).toBe(conversation)
    mockValidateMcpAuth.mockResolvedValue({ ...TURN_AUTH, scopeConversationId: "nope" })
    await POST(call({ url: "https://e.test/" }))
    expect(mockRunWebFetch.mock.calls[1][1].conversationId).toBeNull()
  })

  it("returns a tool error, not a transport error, when the budget is spent or the URL is refused", async () => {
    mockRunWebFetch.mockResolvedValueOnce({ status: "budget_exhausted" })
    const spent = await (await POST(call({ url: "https://e.test/" }))).text()
    expect(spent).toContain('"isError":true')
    expect(spent).toContain("web fetches allowed in one turn")
    mockRunWebFetch.mockResolvedValueOnce({ status: "refused", message: "That address is not a public internet address, so it will not be fetched." })
    const refused = await (await POST(call({ url: "http://127.0.0.1/" }))).text()
    expect(refused).toContain('"isError":true')
    expect(refused).toContain("not a public internet address")
  })

  it.each([
    ["a missing url", {}],
    ["an empty url", { url: "   " }],
    ["an over-long url", { url: `https://e.test/${"a".repeat(3000)}` }],
    ["a non-string url", { url: 5 }],
    ["max_chars over the ceiling", { url: "https://e.test/", max_chars: 50_001 }],
    ["max_chars of zero", { url: "https://e.test/", max_chars: 0 }],
  ])("does not run the fetch for %s", async (_label, args) => {
    const response = await POST(call(args))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"isError":true')
    expect(mockRunWebFetch).not.toHaveBeenCalled()
  })
})
