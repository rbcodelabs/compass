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

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: null }),
}))

await import("@/app/api/mcp/route")

describe("feedback MCP tool schemas", () => {
  it("registers text update, attachment preparation, and attachment completion tools", () => {
    expect(registeredTools.update_feedback).toBeDefined()
    expect(registeredTools.prepare_feedback_attachment_upload).toBeDefined()
    expect(registeredTools.add_feedback_attachment).toBeDefined()
  })

  it("accepts one to five inline attachments on create_feedback", () => {
    const schema = registeredTools.create_feedback.inputSchema.attachments
    const attachment = { filename: "shot.png", data: "data:image/png;base64,UE5H" }
    expect(schema.safeParse([attachment]).success).toBe(true)
    expect(schema.safeParse(Array.from({ length: 5 }, () => attachment)).success).toBe(true)
    expect(schema.safeParse([]).success).toBe(false)
    expect(schema.safeParse(Array.from({ length: 6 }, () => attachment)).success).toBe(false)
  })

  it("uses current feedback statuses while temporarily accepting legacy CLOSED", () => {
    for (const tool of ["list_feedback", "update_feedback_status"]) {
      const schema = registeredTools[tool].inputSchema.status
      expect(schema.safeParse("IN_PROGRESS").success).toBe(true)
      expect(schema.safeParse("COMPLETED").success).toBe(true)
      expect(schema.safeParse("DECLINED").success).toBe(true)
      expect(schema.safeParse("CLOSED").success).toBe(true)
      expect(schema.safeParse("BOGUS").success).toBe(false)
    }
  })

  it("exposes explicit incremental scan inputs without changing the legacy limit", () => {
    const tool = registeredTools.list_feedback.inputSchema
    expect(tool.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect(tool.updatedSince.safeParse("yesterday").success).toBe(false)
    expect(tool.cursor.safeParse("opaque-cursor").success).toBe(true)
    expect(tool.limit.safeParse(100).success).toBe(true)
    expect(tool.limit.safeParse(101).success).toBe(false)
  })
})
