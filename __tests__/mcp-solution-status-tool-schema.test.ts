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

describe("discovery query route registration metadata", () => {
  it("registers factual solution filters without readiness or authority fields", () => {
    const tool = registeredTools.list_solutions
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema)).toEqual([
      "workspaceId",
      "status",
      "opportunityStatus",
      "squadId",
      "hasRoadmapItem",
      // Recency window and ordering are factual too: they read recorded
      // timestamps and make no readiness judgment.
      "updatedSince",
      "updatedBefore",
      "sort",
    ])
    expect(tool.inputSchema.status.safeParse("VALIDATED").success).toBe(true)
    expect(tool.inputSchema.hasRoadmapItem.safeParse(false).success).toBe(true)
    expect(tool.inputSchema.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect(tool.inputSchema.sort.safeParse("recentlyUpdated").success).toBe(true)
    expect("ready" in tool.inputSchema).toBe(false)
    expect("authorized" in tool.inputSchema).toBe(false)
  })

  it("registers factual assumption filters without evidence judgments", () => {
    const tool = registeredTools.list_assumptions
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema)).toEqual([
      "workspaceId",
      "status",
      "riskLevel",
      "solutionStatus",
      "opportunityStatus",
      "squadId",
      // Recency window and ordering are factual too: they read recorded
      // timestamps and make no evidence-sufficiency judgment.
      "updatedSince",
      "updatedBefore",
      "sort",
    ])
    expect(tool.inputSchema.status.safeParse("UNTESTED").success).toBe(true)
    expect(tool.inputSchema.riskLevel.safeParse("HIGH").success).toBe(true)
    expect(tool.inputSchema.updatedBefore.safeParse("2026-09-10T00:00:00.000Z").success).toBe(true)
    expect(tool.inputSchema.sort.safeParse("leastRecentlyUpdated").success).toBe(true)
    expect("ready" in tool.inputSchema).toBe(false)
    expect("sufficientEvidence" in tool.inputSchema).toBe(false)
  })
})
