/**
 * Guard tests for the agent-only web_search MCP route
 * (app/api/agent/web-search/[transport]/route.ts).
 *
 * What matters is what it refuses: off means 404, and anything that is not a
 * server-minted AGENT_TURN API-key credential means 401 before any search is paid for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockValidateMcpAuth = vi.fn()
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: (request: Request) => mockValidateMcpAuth(request) }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))

const mockRunWebSearch = vi.fn()
vi.mock("@/lib/agent-web-search", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/agent-web-search")>()),
  runWebSearch: (...args: unknown[]) => mockRunWebSearch(...args),
}))

const { POST, GET, DELETE } = await import("@/app/api/agent/web-search/[transport]/route")

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
  new Request("https://compass.example/api/agent/web-search/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer turn-credential",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  })

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" }

beforeEach(() => {
  mockValidateMcpAuth.mockReset().mockResolvedValue(TURN_AUTH)
  mockRunWebSearch.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("web_search route gating", () => {
  it.each([
    ["an invalid credential", { valid: false }],
    ["a static user key", { ...TURN_AUTH, purpose: "USER" }],
    ["an OAuth access token", { ...TURN_AUTH, purpose: "OAUTH", credentialType: "OAUTH_TOKEN" }],
    ["a turn credential without a user", { ...TURN_AUTH, userId: null }],
    ["a turn credential without a workspace", { ...TURN_AUTH, scopeWorkspaceId: null }],
    ["a credential that is not an API key row", { ...TURN_AUTH, credentialType: "OAUTH_TOKEN" }],
    ["a credential id that is not a uuid", { ...TURN_AUTH, credentialId: "not-a-uuid" }],
    ["a missing credential id", { ...TURN_AUTH, credentialId: undefined }],
  ])("rejects %s with a JSON-RPC 401", async (_label, auth) => {
    mockValidateMcpAuth.mockResolvedValue(auth)
    const response = await POST(rpc(LIST))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe(-32001)
    expect(mockRunWebSearch).not.toHaveBeenCalled()
  })
})

describe("web_search route tool", () => {
  it("exposes exactly one tool, web_search", async () => {
    const response = await POST(rpc(LIST))
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"web_search"')
    expect((text.match(/"name":/g) ?? []).length).toBe(1)
  })

  it("runs the search bound to the credential's own identity, never the request's", async () => {
    mockRunWebSearch.mockResolvedValue({
      status: "ok",
      remaining: 4,
      results: [{ title: "T", url: "https://e.test/", snippet: "s" }],
    })
    const response = await POST(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search", arguments: { query: "mortgage rates", maxResults: 3 } } }),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("https://e.test/")
    expect(text).toContain("untrusted third-party content")
    expect(mockRunWebSearch).toHaveBeenCalledWith(
      expect.anything(),
      { credentialId: CREDENTIAL, userId: "user-1", workspaceId: "ws-1", conversationId: null },
      { query: "mortgage rates", maxResults: 3 },
    )
  })

  it("returns a tool error, not a transport error, when the budget is spent", async () => {
    mockRunWebSearch.mockResolvedValue({ status: "budget_exhausted" })
    const response = await POST(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } }),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"isError":true')
    expect(text).toContain("web searches allowed in one turn")
  })
})
