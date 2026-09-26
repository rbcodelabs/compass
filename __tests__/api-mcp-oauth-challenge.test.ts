/**
 * The resource server's OAuth behaviour at `/api/mcp`.
 *
 * Everything here is about what a *client* can see and act on, which is why it
 * drives the real route exports rather than the challenge helpers directly:
 *
 *  - the 401 must carry `resource_metadata` (the only thing that makes the
 *    endpoint discoverable from a bare URL) and `scope` (without which Claude
 *    requests every scope in `scopes_supported`);
 *  - a scope shortfall must be a real **403**, not a 200 carrying an error —
 *    Claude ignores `WWW-Authenticate` on a 200;
 *  - the body must still reach the handler after the scope peek has read it;
 *  - a static `cmp_…` key must be entirely unaffected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const validateMcpAuth = vi.fn()
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth }))

const handlerCalls: { body: unknown }[] = []
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (s: { registerTool: () => void }) => void) => {
    setup({ registerTool() {} })
    return async (req: Request) => {
      // The real transport answers a malformed body with a JSON-RPC parse
      // error at HTTP 200, not by throwing. Mirror that.
      const raw = await req.text()
      handlerCalls.push({ body: safeParse(raw) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
  },
}))

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { parseError: raw }
  }
}

const { POST } = await import("@/app/api/mcp/route")

const METADATA_URL = "http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"

function mcpRequest(body: unknown, token = "cmp_oat_token") {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const toolCall = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
})

const oauthActor = (scopes: string[]) => ({
  valid: true,
  userId: "user-1",
  purpose: "USER",
  scopeWorkspaceId: null,
  scopes,
})

beforeEach(() => {
  vi.clearAllMocks()
  handlerCalls.length = 0
})

describe("401 challenge", () => {
  it("advertises the path-inserted metadata document and the minimum scope", async () => {
    validateMcpAuth.mockResolvedValue({ valid: false })
    const response = await POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }))
    expect(response.status).toBe(401)
    const challenge = response.headers.get("www-authenticate")
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`)
    expect(challenge).toContain('scope="mcp:read"')
    expect(challenge).not.toContain("insufficient_scope")
    expect(handlerCalls).toEqual([])
  })

  it("asks for mcp:read even when the unauthenticated request was a write", async () => {
    // The client has no token at all, so the first thing it needs is the
    // minimum grant that gets it talking — not the scope this one call wanted.
    validateMcpAuth.mockResolvedValue({ valid: false })
    const response = await POST(mcpRequest(toolCall("create_opportunity")))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain('scope="mcp:read"')
  })
})

describe("403 insufficient_scope", () => {
  it("rejects a write tool on a read-only token", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:read"]))
    const response = await POST(mcpRequest(toolCall("create_opportunity")))
    expect(response.status).toBe(403)
    const challenge = response.headers.get("www-authenticate")
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="mcp:write"')
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`)
    expect(handlerCalls).toEqual([])
  })

  it("rejects an unclassified tool name on a read-only token (fail-closed)", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:read"]))
    const response = await POST(mcpRequest(toolCall("totally_new_tool")))
    expect(response.status).toBe(403)
  })

  it("takes the strongest requirement in a batch", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:read"]))
    const response = await POST(
      mcpRequest([toolCall("list_opportunities"), toolCall("create_opportunity")]),
    )
    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toContain('scope="mcp:write"')
  })

  it("rejects a read on a token holding neither MCP scope", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["offline_access"]))
    const response = await POST(mcpRequest(toolCall("list_opportunities")))
    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toContain('scope="mcp:read"')
  })
})

describe("requests that pass", () => {
  it("lets a read tool through on a read-only token, body intact", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:read"]))
    const response = await POST(mcpRequest(toolCall("list_opportunities")))
    expect(response.status).toBe(200)
    // The scope peek cloned the request rather than consuming it.
    expect(handlerCalls).toEqual([{ body: toolCall("list_opportunities") }])
  })

  it("lets a write tool through on a write token", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:write"]))
    expect((await POST(mcpRequest(toolCall("create_opportunity")))).status).toBe(200)
  })

  it("lets initialize through on a write-only token (write implies read)", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:write"]))
    const response = await POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }))
    expect(response.status).toBe(200)
  })

  it("leaves static cmp_… keys entirely unscoped", async () => {
    // No `scopes` field → no scope enforcement. Static keys and the
    // MCP_API_KEY service account keep the reach they have always had.
    validateMcpAuth.mockResolvedValue({
      valid: true,
      userId: "user-1",
      purpose: "USER",
      scopeWorkspaceId: null,
    })
    expect((await POST(mcpRequest(toolCall("create_opportunity"), "cmp_key"))).status).toBe(200)
  })

  it("does not 403 an unparseable body — the transport reports the parse error", async () => {
    validateMcpAuth.mockResolvedValue(oauthActor(["mcp:read"]))
    const response = await POST(
      new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer cmp_oat_token", "content-type": "application/json" },
        body: "not json",
      }),
    )
    expect(response.status).toBe(200)
  })
})
