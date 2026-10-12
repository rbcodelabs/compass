import { describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"

type ToolMeta = { inputSchema: Record<string, ZodType> }
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta } })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: null }) }))

await import("@/app/api/mcp/route")

import { AGENT_TOOL_POLICY, TOOL_GATES, TOOL_SCOPES } from "@/lib/mcp-tool-gates"

const WS = "11111111-1111-4111-8111-111111111111"

describe("Artifact direct-upload MCP tool", () => {
  it("registers prepare_artifact_upload with a bounded size and workspace id", () => {
    const tool = registeredTools.prepare_artifact_upload
    expect(tool).toBeDefined()
    expect(tool.inputSchema.workspaceId.safeParse(WS).success).toBe(true)
    expect(tool.inputSchema.workspaceId.safeParse("not-a-uuid").success).toBe(false)
    expect(tool.inputSchema.fileSize.safeParse(2 * 1024 * 1024).success).toBe(true)
    expect(tool.inputSchema.fileSize.safeParse(2 * 1024 * 1024 + 1).success).toBe(false)
    expect(tool.inputSchema.fileSize.safeParse(0).success).toBe(false)
  })

  it("is fail-closed as a workspace-authorized agent write", () => {
    expect(TOOL_GATES.prepare_artifact_upload).toBeDefined()
    expect(TOOL_SCOPES.prepare_artifact_upload).toBe("mcp:write")
    expect(AGENT_TOOL_POLICY.prepare_artifact_upload).toBe("WRITE")
  })

  it("lets create_artifact and update_artifact take an uploadReceipt instead of html", () => {
    for (const name of ["create_artifact", "update_artifact"]) {
      const schema = registeredTools[name].inputSchema
      expect(schema.uploadReceipt.safeParse("abc.def").success).toBe(true)
      expect(schema.uploadReceipt.safeParse("").success).toBe(false)
      expect(schema.uploadReceipt.safeParse(undefined).success).toBe(true)
    }
  })
})
