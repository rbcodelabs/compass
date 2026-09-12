/**
 * Unit tests for the add_to_roadmap and update_roadmap_item MCP tools,
 * focused on start/end date handling.
 *
 * Strategy: mock @/lib/db so no real database is needed, then invoke the
 * tool handler by registering a fake McpServer that captures the callback
 * passed to server.registerTool. We call the callback directly with
 * controlled inputs and assert on the returned text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

// ── Prisma mock ─────────────────────────────────────────────────────────────

const mockPrisma = {
  workspace: {
    findUnique: vi.fn(),
  },
  roadmapItem: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  checklistTemplate: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  checklistTemplateItem: {
    createMany: vi.fn(),
  },
  launchChecklist: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  launchChecklistItem: {
    createMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// ── Fake McpServer that captures every registered tool callback ─────────────

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

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

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }),
}))

// This import must come AFTER all vi.mock() calls.
await import("@/app/api/mcp/route")

// ── Helpers ──────────────────────────────────────────────────────────────────

function getHandler(name: string): ToolCallback {
  const h = registeredTools[name]
  if (!h) throw new Error(`Tool "${name}" was not registered`)
  return ((args: Record<string, unknown>) => runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => h(args))) as ToolCallback
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

beforeEach(() => {
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null)
  mockPrisma.$transaction.mockImplementation((operation: Promise<unknown>[] | ((database: typeof mockPrisma) => unknown)) => Array.isArray(operation) ? Promise.all(operation) : operation(mockPrisma))
})

describe("assign_squad MCP roadmap revision", () => {
  it("bumps updatedAt when assigning a roadmap item", async () => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.update.mockResolvedValue({ id: "item-1" })
    await getHandler("assign_squad")({ objectType: "roadmap_item", objectId: "item-1", squadId: "squad-1" })
    expect(mockPrisma.roadmapItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { squadId: "squad-1", updatedAt: expect.any(Date) },
    })
  })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe("add_to_roadmap MCP tool — dates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "My Product" })
    mockPrisma.roadmapItem.findFirst.mockResolvedValue(null)
    mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null)
    mockPrisma.$transaction.mockImplementation((operation: Promise<unknown>[] | ((database: typeof mockPrisma) => unknown)) => Array.isArray(operation) ? Promise.all(operation) : operation(mockPrisma))
  })

  it("creates an item with startDate/endDate parsed to Date and returns them", async () => {
    mockPrisma.roadmapItem.create.mockResolvedValue({
      id: "item-uuid-1",
      title: "Ship payments",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-09-30"),
    })

    const handler = getHandler("add_to_roadmap")
    const result = await handler({
      workspaceId: "ws-1",
      title: "Ship payments",
      horizon: "NEXT",
      startDate: "2026-07-01",
      endDate: "2026-09-30",
    })
    const text = textOf(result)

    expect(text).toContain("ID: item-uuid-1")
    expect(text).toMatch(/Dates:/)

    const createArgs = mockPrisma.roadmapItem.create.mock.calls[0][0]
    expect(createArgs.data.startDate).toBeInstanceOf(Date)
    expect(createArgs.data.endDate).toBeInstanceOf(Date)
  })

  it("creates an item without dates when omitted", async () => {
    mockPrisma.roadmapItem.create.mockResolvedValue({
      id: "item-uuid-2",
      title: "No dates yet",
      startDate: null,
      endDate: null,
    })

    const handler = getHandler("add_to_roadmap")
    const result = await handler({
      workspaceId: "ws-1",
      title: "No dates yet",
      horizon: "LATER",
    })
    const text = textOf(result)

    expect(text).not.toMatch(/Dates:/)
    const createArgs = mockPrisma.roadmapItem.create.mock.calls[0][0]
    expect(createArgs.data.startDate).toBeUndefined()
    expect(createArgs.data.endDate).toBeUndefined()
  })
})

describe("add_to_roadmap MCP tool — isPrivate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "My Product" })
    mockPrisma.roadmapItem.findFirst.mockResolvedValue(null)
  })

  it("defaults isPrivate to false and omits the Private line when not requested", async () => {
    mockPrisma.roadmapItem.create.mockResolvedValue({
      id: "item-uuid-3",
      title: "Public item",
      isPrivate: false,
    })

    const handler = getHandler("add_to_roadmap")
    const result = await handler({ workspaceId: "ws-1", title: "Public item", horizon: "NEXT" })

    const createArgs = mockPrisma.roadmapItem.create.mock.calls[0][0]
    expect(createArgs.data.isPrivate).toBe(false)
    expect(textOf(result)).not.toMatch(/Private:/)
  })

  it("creates a private item and surfaces it in the response text", async () => {
    mockPrisma.roadmapItem.create.mockResolvedValue({
      id: "item-uuid-4",
      title: "Security fix",
      isPrivate: true,
    })

    const handler = getHandler("add_to_roadmap")
    const result = await handler({
      workspaceId: "ws-1",
      title: "Security fix",
      horizon: "NEXT",
      isPrivate: true,
    })

    const createArgs = mockPrisma.roadmapItem.create.mock.calls[0][0]
    expect(createArgs.data.isPrivate).toBe(true)
    expect(textOf(result)).toMatch(/Private: yes/)
  })
})

describe("update_roadmap_item MCP tool — dates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("updates startDate/endDate, always setting updatedAt explicitly (DSQL requirement)", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
    })
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-08-15"),
    })

    const handler = getHandler("update_roadmap_item")
    const result = await handler({
      itemId: "item-1",
      startDate: "2026-08-01",
      endDate: "2026-08-15",
    })
    const text = textOf(result)

    expect(text).toContain("ID: item-1")
    expect(text).toMatch(/Dates:/)

    const updateArgs = mockPrisma.roadmapItem.update.mock.calls[0][0]
    expect(updateArgs.data.startDate).toBeInstanceOf(Date)
    expect(updateArgs.data.endDate).toBeInstanceOf(Date)
    expect(updateArgs.data.updatedAt).toBeInstanceOf(Date)
  })

  it("returns a not-found message without updating when the item does not exist", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValue(null)

    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "missing-item", startDate: "2026-08-01" })
    const text = textOf(result)

    expect(text).toContain("not found")
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })
})

describe("update_roadmap_item MCP tool — isPrivate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
    })
  })

  it("does not touch isPrivate when omitted from the input", async () => {
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
      isPrivate: false,
    })

    const handler = getHandler("update_roadmap_item")
    await handler({ itemId: "item-1", title: "Renamed" })

    const updateArgs = mockPrisma.roadmapItem.update.mock.calls[0][0]
    expect(updateArgs.data.isPrivate).toBeUndefined()
  })

  it("sets isPrivate: true and surfaces it in the response text", async () => {
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
      isPrivate: true,
    })

    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", isPrivate: true })

    const updateArgs = mockPrisma.roadmapItem.update.mock.calls[0][0]
    expect(updateArgs.data.isPrivate).toBe(true)
    expect(textOf(result)).toMatch(/Private: yes/)
  })

  it("can explicitly clear isPrivate back to false", async () => {
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
      isPrivate: false,
    })

    const handler = getHandler("update_roadmap_item")
    await handler({ itemId: "item-1", isPrivate: false })

    const updateArgs = mockPrisma.roadmapItem.update.mock.calls[0][0]
    expect(updateArgs.data.isPrivate).toBe(false)
  })
})

describe("update_roadmap_item MCP tool — launch horizon guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects horizon: LAUNCHING with no DB read or write, pointing at set_launch_tier", async () => {
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", horizon: "LAUNCHING" })
    const text = textOf(result)

    expect(text).toContain("set_launch_tier")
    expect(mockPrisma.roadmapItem.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects horizon: LAUNCHED with no DB read or write", async () => {
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", horizon: "LAUNCHED" })
    const text = textOf(result)

    expect(text).toMatch(/implemented yet/i)
    expect(mockPrisma.roadmapItem.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })
})

describe("list_roadmap_items MCP tool — LAUNCHING/LAUNCHED visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("includes LAUNCHING and LAUNCHED items in the rendered output (regression: they must not be silently omitted)", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: "now-1", title: "Now item", horizon: "NOW", opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null },
      { id: "launching-1", title: "Launching item", horizon: "LAUNCHING", opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null },
      { id: "launched-1", title: "Launched item", horizon: "LAUNCHED", opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null },
    ])

    const handler = getHandler("list_roadmap_items")
    const result = await handler({ workspaceId: "ws-1" })
    const text = textOf(result)

    expect(text).toContain("Launching item")
    expect(text).toContain("ID: launching-1")
    expect(text).toContain("**LAUNCHING**")
    expect(text).toContain("Launched item")
    expect(text).toContain("ID: launched-1")
    expect(text).toContain("**LAUNCHED**")
  })

  it("accepts horizon: LAUNCHING as an explicit filter", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: "launching-1", title: "Launching item", horizon: "LAUNCHING", opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null },
    ])

    const handler = getHandler("list_roadmap_items")
    const result = await handler({ workspaceId: "ws-1", horizon: "LAUNCHING" })

    expect(mockPrisma.roadmapItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ horizon: "LAUNCHING" }) })
    )
    expect(textOf(result)).toContain("Launching item")
  })
})

describe("list_roadmap_items MCP tool — isPrivate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("marks private items with a lock indicator and leaves public items unmarked", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: "pub-1", title: "Public item", horizon: "NOW", isPrivate: false, opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null },
      { id: "priv-1", title: "Security fix", horizon: "NOW", isPrivate: true, opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null },
    ])

    const handler = getHandler("list_roadmap_items")
    const result = await handler({ workspaceId: "ws-1" })
    const text = textOf(result)

    expect(text).toMatch(/Security fix.*🔒 PRIVATE/)
    expect(text).not.toMatch(/Public item.*🔒 PRIVATE/)
  })
})

describe("list_roadmap_items MCP tool — stable joins and commitment evidence", () => {
  it("returns linkage IDs, rank, timestamps, and provenance without inferring authorization", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z")
    const updatedAt = new Date("2026-09-01T00:00:00.000Z")
    mockPrisma.roadmapItem.findMany.mockResolvedValueOnce([
      {
        id: "roadmap-1",
        title: "Guided setup",
        description: "Reduce setup failures",
        horizon: "NOW",
        status: "ACTIVE",
        sortOrder: 2,
        isPrivate: false,
        opportunityId: "opportunity-1",
        solutionId: "solution-1",
        experimentId: "experiment-1",
        keyResultId: "kr-1",
        feedbackId: "feedback-1",
        squadId: "squad-1",
        nowCommitmentProvenance: "NATIVE_GATED",
        nowDecisionRecordId: "decision-1",
        createdAt,
        updatedAt,
        opportunity: { title: "Setup is confusing" },
        solution: { title: "Guided setup" },
        experiment: { title: "Concierge onboarding" },
        squad: { name: "Activation" },
        startDate: null,
        endDate: null,
      },
    ])

    const result = await getHandler("list_roadmap_items")({ workspaceId: "ws-1", horizon: "NOW" }) as unknown as {
      structuredContent: { data: { items: Array<Record<string, unknown>> } }
    }
    expect(result.structuredContent.data.items[0]).toEqual({
      id: "roadmap-1",
      title: "Guided setup",
      description: "Reduce setup failures",
      horizon: "NOW",
      status: "ACTIVE",
      sortOrder: 2,
      isPrivate: false,
      opportunityId: "opportunity-1",
      opportunity: "Setup is confusing",
      solutionId: "solution-1",
      solution: "Guided setup",
      experimentId: "experiment-1",
      experiment: "Concierge onboarding",
      keyResultId: "kr-1",
      feedbackId: "feedback-1",
      squadId: "squad-1",
      squad: "Activation",
      startDate: null,
      endDate: null,
      nowCommitmentProvenance: "NATIVE_GATED",
      nowDecisionRecordId: "decision-1",
      createdAt,
      updatedAt,
    })
    expect(result.structuredContent.data.items[0]).not.toHaveProperty("authorized")
    expect(result.structuredContent.data.items[0]).not.toHaveProperty("eligible")
  })
})

describe("list_roadmap_items recency filtering and sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      {
        id: "item-1",
        title: "Guided setup",
        horizon: "NOW",
        status: "ACTIVE",
        opportunity: null,
        solution: null,
        squad: null,
        experiment: null,
      },
    ])
  })

  function queryFor() {
    return mockPrisma.roadmapItem.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>
      orderBy: unknown
    }
  }

  it("keeps horizon/sortOrder/id as the default ordering when sort is absent", async () => {
    await getHandler("list_roadmap_items")({ workspaceId: "workspace-1" })

    // The rendered output is grouped into horizon sections off the back of this
    // ordering; changing the default would reshuffle every existing caller's view.
    expect(queryFor().orderBy).toEqual([{ horizon: "asc" }, { sortOrder: "asc" }, { id: "asc" }])
    expect(queryFor().where).not.toHaveProperty("updatedAt")
  })

  it("still scopes to ACTIVE items when a recency window is supplied", async () => {
    await getHandler("list_roadmap_items")({
      workspaceId: "workspace-1",
      updatedSince: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-09-10T00:00:00.000Z",
    })

    expect(queryFor().where).toEqual({
      workspaceId: "workspace-1",
      status: "ACTIVE",
      updatedAt: {
        gte: new Date("2026-09-01T00:00:00.000Z"),
        lt: new Date("2026-09-10T00:00:00.000Z"),
      },
    })
  })

  it("sorts by recency with a stable id tiebreaker", async () => {
    await getHandler("list_roadmap_items")({ workspaceId: "workspace-1", sort: "recentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
  })

  it("sorts least recently updated first for stale-work scans", async () => {
    await getHandler("list_roadmap_items")({ workspaceId: "workspace-1", sort: "leastRecentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
  })

  it("still groups output into horizon sections when sorted by recency", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: "item-next", title: "Later thing", horizon: "NEXT", status: "ACTIVE", opportunity: null, solution: null, squad: null, experiment: null },
      { id: "item-now", title: "Now thing", horizon: "NOW", status: "ACTIVE", opportunity: null, solution: null, squad: null, experiment: null },
    ])

    const result = await getHandler("list_roadmap_items")({ workspaceId: "workspace-1", sort: "recentlyUpdated" })

    // Sort reorders within a section; the NOW section still precedes NEXT.
    expect(textOf(result).indexOf("NOW")).toBeLessThan(textOf(result).indexOf("NEXT"))
  })

  it("combines horizon and squad filters with the recency window", async () => {
    await getHandler("list_roadmap_items")({
      workspaceId: "workspace-1",
      horizon: "NOW",
      squadId: "11111111-1111-4111-8111-111111111111",
      updatedSince: "2026-09-01T00:00:00.000Z",
    })

    expect(queryFor().where).toEqual({
      workspaceId: "workspace-1",
      status: "ACTIVE",
      horizon: "NOW",
      squadId: "11111111-1111-4111-8111-111111111111",
      updatedAt: { gte: new Date("2026-09-01T00:00:00.000Z") },
    })
  })
})
