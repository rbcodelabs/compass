import { describe, expect, it, vi } from "vitest"

type ToolMeta = { title?: string }
const tools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void }) => void) => {
    setup({ registerTool: (name, meta) => { tools[name] = meta } })
    return vi.fn()
  },
}))

await import("@/app/api/mcp/route")

describe("User Guide MCP tool display labels", () => {
  it("keeps the tool IDs while presenting User Guide names", () => {
    expect(tools.search_help?.title).toBe("Search User Guide")
    expect(tools.get_help?.title).toBe("Get User Guide")
  })
})
