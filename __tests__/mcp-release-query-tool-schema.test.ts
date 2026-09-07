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
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

describe("list_release_runs route registration", () => {
  it("registers factual workspace, ledger-state, task, and change filters", () => {
    const schema = registeredTools.list_release_runs.inputSchema
    expect(Object.keys(schema)).toEqual(["workspaceId", "state", "taskId", "updatedSince"])
    expect(schema.state.safeParse("DISPATCH_QUEUED").success).toBe(true)
    expect(schema.state.safeParse("DECISION_RECORDING").success).toBe(true)
    expect(schema.state.safeParse("MERGED").success).toBe(false)
    expect(schema.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect("productionVerified" in schema).toBe(false)
  })

  it("exposes task change-window filters as ISO timestamps", () => {
    const schema = registeredTools.list_tasks.inputSchema
    expect(schema.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect(schema.updatedBefore.safeParse("2026-09-07T00:00:00.000Z").success).toBe(true)
    expect(schema.updatedSince.safeParse("recently").success).toBe(false)
    expect("merged" in schema).toBe(false)
  })
})
