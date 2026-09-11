import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockPrisma = {
  opportunity: {
    findMany: vi.fn(),
  },
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent: {
    ok: boolean
    message: string
    data: unknown
  }
}

type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>

const registeredTools: Record<string, ToolCallback> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (
    setup: (server: {
      registerTool: (name: string, meta: unknown, callback: ToolCallback) => void
    }) => void,
  ) => {
    setup({
      registerTool(name, _meta, callback) {
        registeredTools[name] = callback
      },
    })
    return () => new Response("ok")
  },
}))

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }),
}))

await import("@/app/api/mcp/route")

function getHandler(name: string): ToolCallback {
  const handler = registeredTools[name]
  if (!handler) throw new Error(`Tool "${name}" was not registered`)
  return (args) => runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => handler(args))
}

describe("list_opportunities MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("groups multiline descriptions under each item and preserves structured list metadata", async () => {
    mockPrisma.opportunity.findMany.mockResolvedValue([
      {
        id: "opportunity-1",
        title: "Understand failed onboarding",
        description: "  New admins cannot tell which setup step failed.\n- Check permissions\n\nRetry after inviting a teammate.  ",
        status: "VALIDATING",
        squad: { name: "Activation" },
        linkedKeyResult: {
          title: "Increase activated workspaces",
          objective: { title: "Improve onboarding" },
        },
        _count: { solutions: 2 },
      },
      {
        id: "opportunity-2",
        title: "Whitespace has no meaning",
        description: "  \n  ",
        status: "EXPLORING",
        squad: null,
        linkedKeyResult: null,
        _count: { solutions: 0 },
      },
    ])

    const result = await getHandler("list_opportunities")({
      workspaceId: "workspace-1",
      status: "VALIDATING",
      squadId: "squad-1",
    })

    expect(result.content[0].text).toBe(
      "• **Understand failed onboarding** [VALIDATING] (Activation) — 2 solutions — KR: Improve onboarding / Increase activated workspaces\n" +
      "  Description: New admins cannot tell which setup step failed.\n" +
      "    - Check permissions\n" +
      "    \n" +
      "    Retry after inviting a teammate.\n" +
      "  ID: opportunity-1\n" +
      "• **Whitespace has no meaning** [EXPLORING] — 0 solutions\n" +
      "  ID: opportunity-2",
    )
    expect(result.structuredContent.data).toEqual({
      items: [
        {
          id: "opportunity-1",
          title: "Understand failed onboarding",
          description: "  New admins cannot tell which setup step failed.\n- Check permissions\n\nRetry after inviting a teammate.  ",
          status: "VALIDATING",
          squad: "Activation",
          solutions: 2,
          linkedKeyResult: {
            title: "Increase activated workspaces",
            objective: "Improve onboarding",
          },
        },
        {
          id: "opportunity-2",
          title: "Whitespace has no meaning",
          description: "  \n  ",
          status: "EXPLORING",
          squad: null,
          solutions: 0,
          linkedKeyResult: null,
        },
      ],
      count: 2,
    })
    expect(mockPrisma.opportunity.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        status: "VALIDATING",
        squadId: "squad-1",
      },
      include: {
        linkedKeyResult: {
          select: { title: true, objective: { select: { title: true } } },
        },
        squad: { select: { name: true } },
        _count: { select: { solutions: true } },
      },
      orderBy: { createdAt: "desc" },
    })
  })

  it("preserves null descriptions in structured output without printing literal null", async () => {
    mockPrisma.opportunity.findMany.mockResolvedValue([
      {
        id: "opportunity-2",
        title: "Unspecified opportunity",
        description: null,
        status: "EXPLORING",
        squad: null,
        linkedKeyResult: null,
        _count: { solutions: 0 },
      },
    ])

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1" })
    const data = result.structuredContent.data as {
      items: Array<{ description: string | null }>
    }

    expect(data.items[0].description).toBeNull()
    expect(result.content[0].text).not.toContain("null")
  })
})

describe("list_opportunities recency filtering and sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.opportunity.findMany.mockResolvedValue([
      { id: "opportunity-1", title: "Any", description: null, status: "EXPLORING", squad: null, linkedKeyResult: null, _count: { solutions: 0 } },
    ])
  })

  function queryFor(call: number = 0) {
    return mockPrisma.opportunity.findMany.mock.calls[call][0] as {
      where: Record<string, unknown>
      orderBy: unknown
    }
  }

  it("keeps createdAt desc as the default ordering when sort is absent", async () => {
    await getHandler("list_opportunities")({ workspaceId: "workspace-1" })

    // Changing this default would silently reorder results for every existing caller.
    expect(queryFor().orderBy).toEqual({ createdAt: "desc" })
    expect(queryFor().where).not.toHaveProperty("updatedAt")
  })

  it("filters on a closed updatedSince/updatedBefore window", async () => {
    await getHandler("list_opportunities")({
      workspaceId: "workspace-1",
      updatedSince: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-09-10T00:00:00.000Z",
    })

    expect(queryFor().where.updatedAt).toEqual({
      gte: new Date("2026-09-01T00:00:00.000Z"),
      lt: new Date("2026-09-10T00:00:00.000Z"),
    })
  })

  it("filters on updatedSince alone with an inclusive lower bound", async () => {
    await getHandler("list_opportunities")({ workspaceId: "workspace-1", updatedSince: "2026-09-01T00:00:00.000Z" })

    expect(queryFor().where.updatedAt).toEqual({ gte: new Date("2026-09-01T00:00:00.000Z") })
  })

  it("filters on updatedBefore alone with an exclusive upper bound", async () => {
    await getHandler("list_opportunities")({ workspaceId: "workspace-1", updatedBefore: "2026-09-10T00:00:00.000Z" })

    expect(queryFor().where.updatedAt).toEqual({ lt: new Date("2026-09-10T00:00:00.000Z") })
  })

  it("sorts most recently updated first with a stable id tiebreaker", async () => {
    await getHandler("list_opportunities")({ workspaceId: "workspace-1", sort: "recentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
  })

  it("sorts least recently updated first for stale-work scans", async () => {
    await getHandler("list_opportunities")({ workspaceId: "workspace-1", sort: "leastRecentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
  })

  it("combines a recency window with a recency sort and the pre-existing filters", async () => {
    await getHandler("list_opportunities")({
      workspaceId: "workspace-1",
      status: "ACTIVE",
      squadId: "11111111-1111-4111-8111-111111111111",
      updatedSince: "2026-09-01T00:00:00.000Z",
      sort: "recentlyUpdated",
    })

    expect(queryFor().where).toEqual({
      workspaceId: "workspace-1",
      status: "ACTIVE",
      squadId: "11111111-1111-4111-8111-111111111111",
      updatedAt: { gte: new Date("2026-09-01T00:00:00.000Z") },
    })
    expect(queryFor().orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
  })

  // Input rejection is not asserted here: this harness invokes the tool callback
  // directly, so the registered inputSchema never runs. Schema-level validation
  // is covered in __tests__/mcp-recency-tool-schema.test.ts.
})
