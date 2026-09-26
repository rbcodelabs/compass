import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockExperiment = { findMany: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ experiment: mockExperiment }) }))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent: { ok: boolean; data: unknown }
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

beforeEach(() => vi.clearAllMocks())

describe("list_experiments discovery summary", () => {
  it("filters observable result/change state and returns dates, counts, and stable ancestry IDs", async () => {
    const updatedSince = new Date("2026-09-01T00:00:00.000Z")
    mockExperiment.findMany.mockResolvedValueOnce([
      {
        id: "experiment-1",
        title: "Concierge onboarding",
        status: "RUNNING",
        conclusion: null,
        assumptionId: "assumption-1",
        startDate: new Date("2026-08-20T00:00:00.000Z"),
        endDate: new Date("2026-09-05T00:00:00.000Z"),
        createdAt: new Date("2026-08-15T00:00:00.000Z"),
        updatedAt: new Date("2026-09-03T00:00:00.000Z"),
        squad: { name: "Activation" },
        assumption: {
          id: "assumption-1",
          title: "Admins need guided setup",
          status: "TESTING",
          solution: {
            id: "solution-1",
            title: "Guided setup",
            status: "IDEA",
            opportunity: { id: "opportunity-1", title: "Setup is confusing", status: "ACTIVE" },
          },
        },
        _count: { results: 2 },
        results: [{ createdAt: new Date("2026-09-03T00:00:00.000Z") }],
      },
    ])

    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => registeredTools.list_experiments.callback({
      workspaceId: "workspace-1",
      status: "RUNNING",
      squadId: "squad-1",
      hasResults: true,
      updatedSince: updatedSince.toISOString(),
      endBefore: "2026-09-07T00:00:00.000Z",
    }))

    expect(mockExperiment.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        status: "RUNNING",
        squadId: "squad-1",
        results: { some: {} },
        OR: [
          { updatedAt: { gte: updatedSince } },
          { results: { some: { createdAt: { gte: updatedSince } } } },
        ],
        endDate: { lt: new Date("2026-09-07T00:00:00.000Z") },
      },
      include: {
        squad: { select: { name: true } },
        assumption: {
          select: {
            id: true,
            title: true,
            status: true,
            solution: {
              select: {
                id: true,
                title: true,
                status: true,
                opportunity: { select: { id: true, title: true, status: true } },
              },
            },
          },
        },
        _count: { select: { results: true } },
        results: { select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    })
    expect(result.structuredContent.data).toEqual({
      items: [
        expect.objectContaining({
          id: "experiment-1",
          assumptionId: "assumption-1",
          solutionId: "solution-1",
          opportunityId: "opportunity-1",
          resultCount: 2,
          latestResultAt: new Date("2026-09-03T00:00:00.000Z"),
          startDate: new Date("2026-08-20T00:00:00.000Z"),
          endDate: new Date("2026-09-05T00:00:00.000Z"),
          updatedAt: new Date("2026-09-03T00:00:00.000Z"),
        }),
      ],
      count: 1,
    })
  })

  it("discovers an unchanged experiment when a result was logged after the watermark", async () => {
    const updatedSince = new Date("2026-09-01T00:00:00.000Z")
    mockExperiment.findMany.mockResolvedValueOnce([])

    await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => registeredTools.list_experiments.callback({
      workspaceId: "workspace-1",
      updatedSince: updatedSince.toISOString(),
    }))

    expect(mockExperiment.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "workspace-1",
      OR: [
        { updatedAt: { gte: updatedSince } },
        { results: { some: { createdAt: { gte: updatedSince } } } },
      ],
    })
  })

  it("registers only observable discovery filters", () => {
    const schema = registeredTools.list_experiments.meta.inputSchema
    expect(schema.hasResults.safeParse(true).success).toBe(true)
    expect(schema.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect(schema.endBefore.safeParse("2026-09-07T00:00:00.000Z").success).toBe(true)
    expect(schema.updatedSince.safeParse("last week").success).toBe(false)
    expect("overdue" in schema).toBe(false)
    expect("readyToConclude" in schema).toBe(false)
  })
})
