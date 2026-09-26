/**
 * conclude_experiment MCP tool — NOT_PURSUED coverage.
 *
 * NOT_PURSUED lets a human deliberately close an experiment that was never
 * run (e.g. "the feature already shipped, we don't need to test this").
 * Unlike KILL, it must NOT claim the hypothesis was disproven: the linked
 * Assumption stays UNTESTED, and the experiment lands on a status distinct
 * from KILLED so a deliberate non-pursuit is never mistaken for an
 * evidence-based kill. A reason is required so the human's rationale is
 * durable and visible on the experiment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockExperiment = { findUnique: vi.fn(), update: vi.fn() }
const mockAssumption = { update: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ experiment: mockExperiment, assumption: mockAssumption }) }))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent: { ok: boolean; message: string; data: unknown }
}
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>
type ToolMeta = { inputSchema: Record<string, ZodType> }
const registeredTools: Record<string, { callback: ToolCallback; meta: ToolMeta }> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta, callback: ToolCallback) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta, callback) { registeredTools[name] = { callback, meta } }, registerResource() {} })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

const SERVICE = { userId: null, purpose: "SERVICE" as const }
const callConclude = (args: Record<string, unknown>) =>
  runWithMcpActor(SERVICE, () => registeredTools.conclude_experiment.callback(args))

beforeEach(() => {
  vi.clearAllMocks()
  mockExperiment.findUnique.mockResolvedValue({
    id: "exp-1",
    title: "get_workspace_by_slug experiment",
    status: "DESIGNING",
    assumptionId: "ass-1",
  })
  mockExperiment.update.mockResolvedValue({ id: "exp-1" })
  mockAssumption.update.mockResolvedValue({ id: "ass-1" })
})

describe("conclude_experiment schema", () => {
  it("accepts NOT_PURSUED as a valid conclusion", () => {
    const schema = registeredTools.conclude_experiment.meta.inputSchema
    expect(schema.conclusion.safeParse("NOT_PURSUED").success).toBe(true)
  })
})

describe("conclude_experiment(NOT_PURSUED)", () => {
  it("requires a reason", async () => {
    const result = await callConclude({ experimentId: "exp-1", conclusion: "NOT_PURSUED" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.structuredContent.message).toMatch(/reason/i)
    expect(mockExperiment.update).not.toHaveBeenCalled()
  })

  it("rejects a blank reason", async () => {
    const result = await callConclude({ experimentId: "exp-1", conclusion: "NOT_PURSUED", reason: "   " })
    expect(result.structuredContent.ok).toBe(false)
    expect(mockExperiment.update).not.toHaveBeenCalled()
  })

  it("sets a status distinct from KILLED and persists the reason", async () => {
    const result = await callConclude({
      experimentId: "exp-1",
      conclusion: "NOT_PURSUED",
      reason: "Feature already shipped and works in production; assumption was never disproven.",
    })
    expect(result.structuredContent.ok).toBe(true)
    const data = mockExperiment.update.mock.calls[0][0].data
    expect(data.status).not.toBe("KILLED")
    expect(data.status).toBe("NOT_PURSUED")
    expect(data.conclusion).toBe("NOT_PURSUED")
    expect(data.conclusionReason).toBe("Feature already shipped and works in production; assumption was never disproven.")
  })

  it("leaves the linked assumption UNTESTED, not INVALIDATED", async () => {
    await callConclude({ experimentId: "exp-1", conclusion: "NOT_PURSUED", reason: "Not needed." })
    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: "ass-1" },
      data: { status: "UNTESTED" },
    })
  })

  it("refuses to re-conclude an already NOT_PURSUED experiment", async () => {
    mockExperiment.findUnique.mockResolvedValue({
      id: "exp-1",
      title: "Already closed",
      status: "NOT_PURSUED",
      assumptionId: "ass-1",
    })
    const result = await callConclude({ experimentId: "exp-1", conclusion: "NOT_PURSUED", reason: "Again." })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.structuredContent.message).toMatch(/already concluded/i)
  })
})
