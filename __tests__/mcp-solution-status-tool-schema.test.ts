import { describe, expect, it, vi } from "vitest"
import { z, type ZodType } from "zod"

type ToolMeta = { inputSchema: Record<string, ZodType> }
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta } })
    return () => new Response("ok")
  },
}))

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: null }),
}))

await import("@/app/api/mcp/route")

describe("update_solution_status route registration metadata", () => {
  it("registers exactly the required lifecycle argument schemas", () => {
    const tool = registeredTools.update_solution_status

    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema)).toEqual(["solutionId", "status"])

    const schema = z.object(tool.inputSchema)
    const validId = "7df95340-297e-40e7-b021-42e2ecbf22e3"

    for (const status of ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"]) {
      expect(schema.safeParse({ solutionId: validId, status }).success).toBe(true)
    }

    expect(schema.safeParse({ solutionId: validId, status: "ACTIVE" }).success).toBe(false)
    expect(schema.safeParse({ solutionId: validId }).success).toBe(false)
    expect(schema.safeParse({ status: "SHIPPED" }).success).toBe(false)
    expect(schema.safeParse({ solutionId: "not-a-uuid", status: "SHIPPED" }).success).toBe(false)
  })
})
