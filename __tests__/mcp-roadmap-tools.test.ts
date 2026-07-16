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
    create: vi.fn(),
    update: vi.fn(),
  },
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
