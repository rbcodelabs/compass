/**
 * get_workspace_summary exposes the workspace's thinking-model vocabulary,
 * additively: structured `thinkingModel` plus one text line when entities are
 * renamed. Same harness as mcp-get-workspace-by-slug.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockPrisma = {
  workspace: { findUnique: vi.fn() },
  oKRCycle: { count: vi.fn(), findFirst: vi.fn() },
  opportunity: { count: vi.fn() },
  experiment: { count: vi.fn() },
  roadmapItem: { count: vi.fn() },
  squad: { findMany: vi.fn() },
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>
const registeredTools: Record<string, ToolCallback> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void }) => void) => {
    setup({
      registerTool(name, _meta, cb) {
        registeredTools[name] = cb
      },
    })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

const call = (args: Record<string, unknown>) =>
  runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => registeredTools["get_workspace_summary"](args))

const ID = "00000000-0000-4000-8000-000000000001"

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.oKRCycle.count.mockResolvedValue(0)
  mockPrisma.oKRCycle.findFirst.mockResolvedValue(null)
  mockPrisma.opportunity.count.mockResolvedValue(0)
  mockPrisma.experiment.count.mockResolvedValue(0)
  mockPrisma.roadmapItem.count.mockResolvedValue(0)
  mockPrisma.squad.findMany.mockResolvedValue([])
})

describe("get_workspace_summary thinking-model vocabulary", () => {
  it("selects the two columns in the existing single workspace row query", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "W", thinkingModel: null, thinkingModelLabels: null })
    await call({ workspaceId: ID })
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledTimes(1)
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: ID },
      select: { name: true, thinkingModel: true, thinkingModelLabels: true },
    })
  })

  it("Torres workspace: structured labels and the vocabulary line", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "W", thinkingModel: "TORRES_OST", thinkingModelLabels: null })
    const result = await call({ workspaceId: ID })
    expect(result.content[0].text).toContain("custom display names for Objectives and Key Results")
    const data = (result.structuredContent as { data: { thinkingModel?: { key: string; name: string; labels: Record<string, unknown> } } }).data
    const tm = data.thinkingModel
    expect(tm?.key).toBe("TORRES_OST")
    expect(tm?.labels.objective).toEqual({ singular: "Outcome", plural: "Outcomes" })
  })

  it("NULL workspace: CLASSIC structured data and no extra text line", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "W", thinkingModel: null, thinkingModelLabels: null })
    const result = await call({ workspaceId: ID })
    expect(result.content[0].text).not.toContain("custom display names")
    expect(JSON.stringify(result)).toContain('"key":"CLASSIC"')
  })
})
