import { describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"

type ToolMeta = { inputSchema: Record<string, ZodType> }
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta }, registerResource() {} })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: null }) }))

await import("@/app/api/mcp/route")

import { AGENT_TOOL_POLICY, TOOL_GATES, TOOL_SCOPES } from "@/lib/mcp-tool-gates"

describe("Docs image MCP tool", () => {
  it("registers a workspace-scoped private direct-upload preparation tool", () => {
    const tool = registeredTools.prepare_doc_image_upload
    expect(tool).toBeDefined()
    expect(tool.inputSchema.workspaceId.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(true)
    expect(tool.inputSchema.fileType.safeParse("image/png").success).toBe(true)
    expect(tool.inputSchema.fileType.safeParse("image/svg+xml").success).toBe(false)
    expect(tool.inputSchema.fileSize.safeParse(10 * 1024 * 1024).success).toBe(true)
    expect(tool.inputSchema.fileSize.safeParse(10 * 1024 * 1024 + 1).success).toBe(false)
  })

  it("is fail-closed as a workspace-authorized agent write", () => {
    expect(TOOL_GATES.prepare_doc_image_upload).toBeDefined()
    expect(TOOL_SCOPES.prepare_doc_image_upload).toBe("mcp:write")
    expect(AGENT_TOOL_POLICY.prepare_doc_image_upload).toBe("WRITE")
  })
})
