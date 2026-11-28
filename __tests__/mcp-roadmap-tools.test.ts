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
import { z } from "zod"
import { setModules } from "./helpers/modules";

const { linkedTaskIds } = vi.hoisted(() => ({ linkedTaskIds: vi.fn() }))
vi.mock("@/lib/task-links-read", () => ({ getTaskIdsLinkedTo: linkedTaskIds }))
vi.mock("@/lib/custom-field-bulk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/custom-field-bulk")>()),
  resolveCustomFieldColumns: vi.fn().mockResolvedValue({ ok: true, columns: [] }),
  loadCustomFieldValuesFor: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock("@/lib/work-item-sequence", async () => (await import("./helpers/work-item-sequence-mock")).workItemSequenceMock())

// ── Prisma mock ─────────────────────────────────────────────────────────────

const mockPrisma = {
  workspace: {
    findUnique: vi.fn(),
  },
  squad: { findFirst: vi.fn() },
  task: { findMany: vi.fn() },
  solution: { findFirst: vi.fn() },
  opportunity: { findFirst: vi.fn() },
  keyResult: { findFirst: vi.fn() },
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

type ToolCallback = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  structuredContent?: { data: unknown }
}>

const registeredTools: Record<string, ToolCallback> = {}
const registeredSchemas: Record<string, Record<string, z.ZodType>> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({
      registerTool(name, _meta, cb) {
        registeredTools[name] = cb
        registeredSchemas[name] = (_meta as { inputSchema: Record<string, z.ZodType> }).inputSchema
      },
      registerResource() {},
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
  mockPrisma.squad.findFirst.mockResolvedValue({ id: "linked" })
  mockPrisma.solution.findFirst.mockResolvedValue({ id: "linked" })
  mockPrisma.opportunity.findFirst.mockResolvedValue({ id: "linked" })
  mockPrisma.keyResult.findFirst.mockResolvedValue({ id: "linked" })
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

describe("update_roadmap_item MCP tool — optional links", () => {
  const fields = ["keyResultId", "opportunityId", "solutionId", "squadId"] as const
  const targetId = "11111111-1111-4111-8111-111111111111"

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({
      id: "item-1", workspaceId: "ws-1", title: "Item", horizon: "LATER", status: "ACTIVE",
    })
    mockPrisma.roadmapItem.update.mockImplementation(async ({ data }) => ({
      id: "item-1", title: "Item", horizon: "LATER", status: "ACTIVE", ...data,
    }))
  })

  it.each(fields)("validates %s as optional nullable UUID", (field) => {
    const schema = registeredSchemas.update_roadmap_item[field]
    expect(schema, field).toBeDefined()
    for (const value of [undefined, null, targetId]) expect(schema.safeParse(value).success).toBe(true)
    for (const value of ["", "not-a-uuid", 123]) expect(schema.safeParse(value).success).toBe(false)
  })

  it.each(fields)("sets and explicitly clears %s", async (field) => {
    for (const value of [targetId, null]) {
      const result = await getHandler("update_roadmap_item")({ itemId: "item-1", [field]: value })
      expect(mockPrisma.roadmapItem.update).toHaveBeenLastCalledWith({
        where: { id: "item-1" }, data: { [field]: value, updatedAt: expect.any(Date) },
      })
      expect(textOf(result)).toContain("ID: item-1")
    }
  })

  it("preserves omitted links in a mixed update while retaining ordinary fields", async () => {
    await getHandler("update_roadmap_item")({
      itemId: "item-1", keyResultId: targetId, solutionId: null, title: " Updated ",
      horizon: "NEXT", status: "ACTIVE", isPrivate: false, startDate: "2026-09-01",
    })
    const data = mockPrisma.roadmapItem.update.mock.calls[0][0].data
    expect(data).toEqual({
      keyResultId: targetId, solutionId: null, title: "Updated", horizon: "NEXT",
      status: "ACTIVE", isPrivate: false, startDate: new Date("2026-09-01"), updatedAt: expect.any(Date),
      // A hand-set schedule ends the item following its solution (migration 075).
      scheduleEditedAt: expect.any(Date),
    })
    expect(data).not.toHaveProperty("opportunityId")
    expect(data).not.toHaveProperty("squadId")
  })

  it("preserves the linked Solution response contract when setting and clearing links", async () => {
    const linked = await getHandler("update_roadmap_item")({ itemId: "item-1", solutionId: targetId })
    expect(textOf(linked)).toContain(`Linked Solution: ${targetId}`)
    expect(linked.structuredContent?.data).toMatchObject({ solutionId: targetId })

    const cleared = await getHandler("update_roadmap_item")({ itemId: "item-1", solutionId: null })
    expect(textOf(cleared)).not.toContain("Linked Solution:")
    expect(cleared.structuredContent?.data).toMatchObject({ solutionId: null })
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

describe("update_roadmap_item MCP tool — Solution link", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({
      id: "item-1",
      workspaceId: "ws-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
    })
  })

  it("attaches or replaces the linked Solution and returns its ID", async () => {
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Ship payments",
      horizon: "NOW",
      status: "ACTIVE",
      solutionId: "solution-2",
      isPrivate: false,
      startDate: null,
      endDate: null,
    })

    const result = await getHandler("update_roadmap_item")({
      itemId: "item-1",
      solutionId: "solution-2",
    })

    expect(mockPrisma.roadmapItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { solutionId: "solution-2", updatedAt: expect.any(Date) },
    })
    expect(textOf(result)).toContain("Linked Solution: solution-2")
    expect(result.structuredContent?.data).toMatchObject({ solutionId: "solution-2" })
  })

  it("preserves the existing Solution link when solutionId is omitted", async () => {
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Renamed",
      horizon: "NOW",
      status: "ACTIVE",
      solutionId: "existing-solution",
      isPrivate: false,
      startDate: null,
      endDate: null,
    })

    await getHandler("update_roadmap_item")({ itemId: "item-1", title: "Renamed" })

    expect(mockPrisma.roadmapItem.update.mock.calls[0][0].data.solutionId).toBeUndefined()
  })
})

describe("update_roadmap_item MCP tool — launch horizon guard", () => {
  // The handler now needs one read (the item, to resolve its workspace) to
  // decide which rejection message applies — the disabled-feature message
  // when the workspace's launch workflow is off, or the old "use
  // set_launch_tier" / "not implemented" messages when it's on. It never
  // writes in either case.
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({
      id: "item-1", workspaceId: "ws-1", title: "Item", horizon: "NOW", status: "ACTIVE",
    })
  })

  it("returns a not-found message and writes nothing for a missing item", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValueOnce(null)
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "missing-item", horizon: "LAUNCHING" })

    expect(textOf(result)).toContain("not found")
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects horizon: LAUNCHING with the disabled-feature message when the workspace's launch workflow is off, without writing", async () => {
    setModules({ launch_workflow: false })
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", horizon: "LAUNCHING" })

    expect(textOf(result)).toMatch(/launch workflow is disabled/i)
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects horizon: LAUNCHED with the disabled-feature message when off, without writing", async () => {
    setModules({ launch_workflow: false })
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", horizon: "LAUNCHED" })

    expect(textOf(result)).toMatch(/launch workflow is disabled/i)
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects horizon: LAUNCHING pointing at set_launch_tier when the launch workflow is on, without writing", async () => {
    setModules({ launch_workflow: true })
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", horizon: "LAUNCHING" })

    expect(textOf(result)).toContain("set_launch_tier")
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects horizon: LAUNCHED when the launch workflow is on, without writing", async () => {
    setModules({ launch_workflow: true })
    const handler = getHandler("update_roadmap_item")
    const result = await handler({ itemId: "item-1", horizon: "LAUNCHED" })

    expect(textOf(result)).toMatch(/implemented yet/i)
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
      displayId: null,
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

// ── Display IDs (RM-n) ───────────────────────────────────────────────────────

describe("list_roadmap_items MCP tool — display IDs", () => {
  const base = { opportunity: null, solution: null, squad: null, experiment: null, startDate: null, endDate: null }
  beforeEach(() => vi.clearAllMocks())

  it("shows displayId in the full text and structured output, null for an un-numbered item", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { ...base, id: "u-1", title: "Numbered", horizon: "NOW", seqPrefix: "RM", seqNumber: 10 },
      { ...base, id: "u-2", title: "Old row", horizon: "NOW", seqPrefix: null, seqNumber: null },
    ])
    const result = await getHandler("list_roadmap_items")({ workspaceId: "ws-1" }) as unknown as { content: Array<{ text: string }>; structuredContent: { data: { items: Array<{ id: string; displayId: string | null }> } } }
    const text = result.content[0].text
    expect(text).toMatch(/Numbered[\s\S]*ID: u-1\n\s+Display ID: RM-10/)
    expect(text).not.toMatch(/ID: u-2\n\s+Display ID/)
    expect(result.structuredContent.data.items.map((i) => [i.id, i.displayId])).toEqual([["u-1", "RM-10"], ["u-2", null]])
  })

  it("shows displayId in compact text and structured output too, and selects the sequence columns", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: "u-1", title: "Numbered", horizon: "NOW", squad: null, seqPrefix: "RM", seqNumber: 10 },
      { id: "u-2", title: "Old row", horizon: "NOW", squad: null, seqPrefix: null, seqNumber: null },
    ])
    const result = await getHandler("list_roadmap_items")({ workspaceId: "ws-1", compact: true }) as unknown as { content: Array<{ text: string }>; structuredContent: { data: { items: Array<{ id: string; displayId: string | null }> } } }
    expect(mockPrisma.roadmapItem.findMany.mock.calls[0][0].select).toMatchObject({ seqPrefix: true, seqNumber: true })
    const lines = result.content[0].text.split("\n")
    expect(lines.find((l) => l.includes("[u-1]"))).toContain("RM-10")
    expect(lines.find((l) => l.includes("[u-2]"))).not.toMatch(/RM-/)
    expect(result.structuredContent.data.items.map((i) => i.displayId)).toEqual(["RM-10", null])
  })
})

describe("get_roadmap_item MCP tool", () => {
  const ITEM = "55555555-5555-4555-8555-555555555555"
  const WS = "66666666-6666-4666-8666-666666666666"
  const row = {
    id: ITEM, workspaceId: WS, seqPrefix: "RM", seqNumber: 10, title: "Guided setup", description: "Reduce failures", horizon: "NOW", status: "ACTIVE",
    isPrivate: false, sortOrder: 2, startDate: new Date("2026-07-01"), endDate: null, nowCommitmentProvenance: "NATIVE_GATED", nowDecisionRecordId: "dec-1",
    opportunityId: "o-1", solutionId: "s-1", experimentId: "e-1", keyResultId: "k-1", feedbackId: "f-1", squadId: "q-1",
    opportunity: { id: "o-1", title: "Setup confusing", seqPrefix: "OPP", seqNumber: 3 },
    solution: { id: "s-1", title: "Wizard", seqPrefix: "SOL", seqNumber: 4 },
    experiment: { id: "e-1", title: "Concierge", seqPrefix: "EXP", seqNumber: 5 },
    keyResult: { id: "k-1", title: "Activation 40%", seqPrefix: "KR", seqNumber: 6 },
    feedback: { id: "f-1", title: "Setup hard", seqPrefix: "FB", seqNumber: 7 },
    squad: { id: "q-1", name: "Activation" },
    createdAt: new Date("2026-08-01"), updatedAt: new Date("2026-09-01"),
  }
  type Result = { content: Array<{ text: string }>; structuredContent: { ok: boolean; data: Record<string, unknown> | null } }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.roadmapItem.findFirst.mockResolvedValue(row)
    mockPrisma.task.findMany.mockResolvedValue([{ id: "t-1", title: "Build wizard", status: "IN_PROGRESS", seqPrefix: "TASK", seqNumber: 12 }])
    linkedTaskIds.mockResolvedValue(["t-1"])
  })

  it("returns full detail by UUID, scoped to the item's own row", async () => {
    const result = await getHandler("get_roadmap_item")({ roadmapItemId: ITEM }) as unknown as Result
    expect(mockPrisma.roadmapItem.findFirst.mock.calls[0][0].where).toEqual({ id: ITEM })
    const data = result.structuredContent.data!
    expect(data).toMatchObject({
      id: ITEM, displayId: "RM-10", title: "Guided setup", description: "Reduce failures", horizon: "NOW", status: "ACTIVE", isPrivate: false, sortOrder: 2,
      endDate: null, nowCommitmentProvenance: "NATIVE_GATED", nowDecisionRecordId: "dec-1", squad: { id: "q-1", name: "Activation" },
      opportunity: { id: "o-1", displayId: "OPP-3", title: "Setup confusing" }, solution: { id: "s-1", displayId: "SOL-4", title: "Wizard" },
      experiment: { id: "e-1", displayId: "EXP-5", title: "Concierge" }, keyResult: { id: "k-1", displayId: "KR-6", title: "Activation 40%" },
      feedback: { id: "f-1", displayId: "FB-7", title: "Setup hard" }, tasks: [{ id: "t-1", displayId: "TASK-12", title: "Build wizard", status: "IN_PROGRESS" }],
    })
    expect(linkedTaskIds).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, linkedType: "ROADMAP_ITEM", linkedId: ITEM })
    expect(mockPrisma.task.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS })
    const text = result.content[0].text
    expect(text).toContain("RM-10")
    expect(text).toContain("Guided setup")
    expect(text).toContain("TASK-12")
    expect(text).toContain(`ID: ${ITEM}`)
  })

  it("resolves RM-10 plus workspaceId and fetches only inside that workspace", async () => {
    mockPrisma.roadmapItem.findFirst.mockImplementation(async ({ where }: { where: { id?: string; workspaceId?: string; seqNumber?: number } }) =>
      where.workspaceId === WS && (where.id === ITEM || where.seqNumber === 10) ? (where.id ? row : { id: ITEM, seqPrefix: "RM", seqNumber: 10 }) : null)
    const result = await getHandler("get_roadmap_item")({ roadmapItemId: "RM-10", workspaceId: WS }) as unknown as Result
    expect(result.structuredContent.data).toMatchObject({ id: ITEM, displayId: "RM-10" })
    // The detail read carries the workspace as well as the id.
    expect(mockPrisma.roadmapItem.findFirst.mock.calls.at(-1)![0].where).toEqual({ id: ITEM, workspaceId: WS })
  })

  it("does not return an item from another workspace when a UUID is paired with the wrong workspaceId", async () => {
    mockPrisma.roadmapItem.findFirst.mockImplementation(async ({ where }: { where: { id: string; workspaceId?: string } }) => (where.workspaceId && where.workspaceId !== WS ? null : row))
    const result = await getHandler("get_roadmap_item")({ roadmapItemId: ITEM, workspaceId: "77777777-7777-4777-8777-777777777777" }) as unknown as Result
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/not found/i)
    expect(result.content[0].text).not.toContain("Guided setup")
    expect(linkedTaskIds).not.toHaveBeenCalled()
  })

  it("asks for workspaceId when given a display ID without one", async () => {
    await expect(getHandler("get_roadmap_item")({ roadmapItemId: "RM-10" })).rejects.toThrow(/pass workspaceId/)
    expect(mockPrisma.roadmapItem.findFirst).not.toHaveBeenCalled()
  })

  it("reports a missing item as not found", async () => {
    mockPrisma.roadmapItem.findFirst.mockResolvedValue(null)
    const result = await getHandler("get_roadmap_item")({ roadmapItemId: ITEM }) as unknown as Result
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("not found")
  })

  it("accepts a display ID in the schema and adds an optional workspaceId", () => {
    const schema = z.object(registeredSchemas.get_roadmap_item)
    expect(schema.safeParse({ roadmapItemId: "RM-10", workspaceId: WS }).success).toBe(true)
    expect(schema.safeParse({ roadmapItemId: ITEM }).success).toBe(true)
    expect(schema.safeParse({ roadmapItemId: "TASK-1" }).success).toBe(true) // shape only; the resolver names the wrong type
    expect(schema.safeParse({ roadmapItemId: "nonsense" }).success).toBe(false)
  })
})

describe("update_roadmap_item MCP tool — display IDs", () => {
  const ITEM = "88888888-8888-4888-8888-888888888888"
  const WS = "99999999-9999-4999-8999-999999999999"
  const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  beforeEach(() => {
    vi.clearAllMocks()
    // RM-10 exists only in WS.
    mockPrisma.roadmapItem.findFirst.mockImplementation(async ({ where }: { where: { workspaceId: string; seqNumber?: number } }) =>
      where.workspaceId === WS && where.seqNumber === 10 ? { id: ITEM, seqPrefix: "RM", seqNumber: 10 } : null)
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({ id: ITEM, workspaceId: WS, title: "Item", horizon: "LATER", status: "ACTIVE" })
    mockPrisma.roadmapItem.update.mockImplementation(async ({ data, where }) => ({ id: where.id, title: "Item", horizon: "LATER", status: "ACTIVE", ...data }))
  })

  it("updates the row RM-10 names in the given workspace", async () => {
    const result = await getHandler("update_roadmap_item")({ itemId: "rm-10", workspaceId: WS, title: "Renamed" })
    expect(mockPrisma.roadmapItem.update.mock.calls[0][0].where).toEqual({ id: ITEM })
    expect(textOf(result)).toContain(`ID: ${ITEM}`)
  })

  it("still updates by UUID", async () => {
    await getHandler("update_roadmap_item")({ itemId: ITEM, title: "Renamed" })
    expect(mockPrisma.roadmapItem.update.mock.calls[0][0].where).toEqual({ id: ITEM })
  })

  it("rejects RM-10 in a workspace that does not hold it, and writes nothing", async () => {
    await expect(getHandler("update_roadmap_item")({ itemId: "RM-10", workspaceId: OTHER, title: "x" })).rejects.toThrow("RM-10 was not found in this workspace.")
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("rejects a display ID with no workspaceId, and writes nothing", async () => {
    await expect(getHandler("update_roadmap_item")({ itemId: "RM-10", title: "x" })).rejects.toThrow(/pass workspaceId/)
    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("widens itemId on update_roadmap_item and set_launch_tier only", () => {
    expect(z.object(registeredSchemas.update_roadmap_item).safeParse({ itemId: "RM-10", workspaceId: WS }).success).toBe(true)
    expect(z.object(registeredSchemas.set_launch_tier).safeParse({ itemId: "RM-10", workspaceId: WS, tier: "TIER_1" }).success).toBe(true)
    expect(z.object(registeredSchemas.update_launch_checklist_item).safeParse({ itemId: "RM-10", status: "DONE" }).success).toBe(false)
  })
})
