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
  $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
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
  return h
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("add_to_roadmap MCP tool — dates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "My Product" })
    mockPrisma.roadmapItem.findFirst.mockResolvedValue(null)
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
      horizon: "NOW",
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
    const result = await handler({ workspaceId: "ws-1", title: "Public item", horizon: "NOW" })

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
      horizon: "NOW",
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
