import type { ZodType } from "zod"
import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

type ToolMeta = {
  description: string
  inputSchema: ZodType
  outputSchema?: Record<string, ZodType>
}
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta }, registerResource() {} })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn() }))

await import("@/app/api/mcp/route")

describe("update_opportunity MCP schema", () => {
  const validId = "e1b57392-d269-4fa7-bca1-140a815cbb92"

  it("is exposed with only opportunity metadata fields and an output schema", () => {
    const tool = registeredTools.update_opportunity

    expect(tool).toBeDefined()
    expect(tool.outputSchema).toBeDefined()
    expect(tool.description).toMatch(/title.*description/i)
    expect(tool.description).not.toMatch(/status|lifecycle/i)
  })

  it("accepts valid partial updates and rejects invalid inputs", () => {
    const schema = registeredTools.update_opportunity.inputSchema

    expect(schema.safeParse({ opportunityId: validId, title: "New title" }).success).toBe(true)
    expect(schema.safeParse({ opportunityId: validId, description: "New detail" }).success).toBe(true)
    expect(schema.safeParse({ opportunityId: validId, description: null }).success).toBe(true)
    expect(schema.safeParse({ opportunityId: validId }).success).toBe(false)
    expect(schema.safeParse({ opportunityId: validId, title: "   " }).success).toBe(false)
    expect(schema.safeParse({ opportunityId: validId, title: "x".repeat(256) }).success).toBe(false)
    expect(schema.safeParse({ opportunityId: validId, description: "  " }).success).toBe(false)
    expect(schema.safeParse({ opportunityId: "not-a-uuid", title: "New title" }).success).toBe(false)
    expect(schema.safeParse({ opportunityId: validId, status: "ACTIVE" }).success).toBe(false)
  })

  it("advertises the real input fields through the MCP SDK tools/list response", async () => {
    const meta = registeredTools.update_opportunity
    const server = new McpServer({ name: "opportunity-schema-test", version: "1.0.0" })
    server.registerTool("update_opportunity", meta, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }))
    const client = new Client({ name: "opportunity-schema-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "update_opportunity")

      expect(listed?.inputSchema).not.toEqual({ type: "object", properties: {} })
      expect(Object.keys(listed?.inputSchema.properties ?? {})).toEqual([
        "opportunityId",
        "expectedUpdatedAt",
        "expectedFieldsFingerprint",
        "customerSegment",
        "title",
        "description",
      ])
      expect(listed?.inputSchema.required).toContain("opportunityId")
      expect(meta.inputSchema.safeParse({ opportunityId: validId }).success).toBe(false)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
