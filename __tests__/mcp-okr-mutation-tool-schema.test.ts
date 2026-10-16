import { describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"

type ToolMeta = {
  description: string
  inputSchema: Record<string, ZodType>
}

const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta }, registerResource() {} })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

describe("OKR mutation MCP schemas", () => {
  it("registers all four mutation tools", () => {
    expect(Object.keys(registeredTools)).toEqual(expect.arrayContaining([
      "update_objective",
      "delete_objective",
      "update_key_result",
      "delete_key_result",
    ]))
  })

  it("restricts update_objective status to the supported values", () => {
    const status = registeredTools.update_objective.inputSchema.status

    for (const value of ["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"]) {
      expect(status.safeParse(value).success).toBe(true)
    }
    expect(status.safeParse("DRAFT").success).toBe(false)
  })

  it("makes all update fields optional while retaining required IDs", () => {
    const objective = registeredTools.update_objective.inputSchema
    const keyResult = registeredTools.update_key_result.inputSchema

    expect(objective.objectiveId.safeParse(undefined).success).toBe(false)
    expect(objective.title.safeParse(undefined).success).toBe(true)
    expect(objective.description.safeParse(undefined).success).toBe(true)
    expect(objective.status.safeParse(undefined).success).toBe(true)
    expect(keyResult.keyResultId.safeParse(undefined).success).toBe(false)
    expect(keyResult.title.safeParse(undefined).success).toBe(true)
    expect(keyResult.target.safeParse(undefined).success).toBe(true)
    expect(keyResult.unit.safeParse(undefined).success).toBe(true)
    expect(keyResult.current.safeParse(undefined).success).toBe(true)
  })

  it("documents safe delete behavior in the tool descriptions", () => {
    expect(registeredTools.delete_objective.description).toMatch(/refuses.*Key Results/i)
    expect(registeredTools.delete_key_result.description).toMatch(/unlinks.*Opportunities.*Objectives.*Roadmap/i)
    expect(registeredTools.delete_key_result.description).toMatch(/Check-?Ins.*deleted/i)
  })
})
