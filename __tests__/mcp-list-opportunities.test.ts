import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockPrisma = {
  opportunity: {
    findMany: vi.fn(),
    count: vi.fn(),
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
    mockPrisma.opportunity.count.mockResolvedValue(2)
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
      total: 2,
      hasMore: false,
      nextCursor: null,
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
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 51,
    })
    // The total is counted against the filters but WITHOUT the keyset bound, so
    // it stays the denominator for the whole listing rather than the page.
    expect(mockPrisma.opportunity.count).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", status: "VALIDATING", squadId: "squad-1" },
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
    mockPrisma.opportunity.count.mockResolvedValue(1)
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

  it("keeps createdAt desc as the default ordering, with a stable id tiebreaker", async () => {
    await getHandler("list_opportunities")({ workspaceId: "workspace-1" })

    // The primary key and its direction are unchanged, so existing callers see the
    // same ordering. The added `id` tiebreaker only disambiguates rows sharing a
    // `createdAt` — previously arbitrary and free to differ between identical
    // calls, which a keyset cursor cannot be built over.
    expect(queryFor().orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }])
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

describe("list_opportunities keyset pagination", () => {
  const EPOCH = Date.UTC(2026, 8, 20)

  /** `n` rows, descending by createdAt, numbered from `offset + 1`. */
  function makeRows(n: number, offset = 0) {
    return Array.from({ length: n }, (_, i) => {
      const index = offset + i
      return {
        id: `opportunity-${index + 1}`,
        title: `Opportunity ${index + 1}`,
        description: null,
        status: "EXPLORING",
        squad: null,
        linkedKeyResult: null,
        _count: { solutions: 0 },
        createdAt: new Date(EPOCH - index * 86_400_000),
        updatedAt: new Date(EPOCH - index * 86_400_000),
      }
    })
  }

  function queryFor(call: number) {
    return mockPrisma.opportunity.findMany.mock.calls[call][0] as {
      where: Record<string, unknown>
      orderBy: unknown
      take: number
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("bounds the page and states the total, the remainder and the cursor in the text block", async () => {
    // 139 matching rows — the real Strategic Initiatives workspace size that
    // prompted this change. Asking for 2 must not return 139.
    mockPrisma.opportunity.count.mockResolvedValue(139)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(3))

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2 })
    const data = result.structuredContent.data as {
      count: number
      total: number
      hasMore: boolean
      nextCursor: string | null
    }

    expect(data.count).toBe(2)
    expect(data.total).toBe(139)
    expect(data.hasMore).toBe(true)
    expect(data.nextCursor).toBeTruthy()
    // Over-fetch by exactly one to detect a further page.
    expect(queryFor(0).take).toBe(3)
    // The footer is the part that stops a caller believing it saw everything.
    expect(result.content[0].text).toContain("Showing 1-2 of 139.")
    expect(result.content[0].text).toContain("137 not yet listed.")
    expect(result.content[0].text).toContain(`cursor: "${data.nextCursor}"`)
    expect(result.content[0].text).toContain("Do NOT start over from the first page")
  })

  it("resumes strictly after the last row of the previous page", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(139)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(3))
    const page1 = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2 })
    const cursor = (page1.structuredContent.data as { nextCursor: string }).nextCursor

    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(3, 2))
    const page2 = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2, cursor })

    // Keyset bound, not OFFSET: everything ordered after (createdAt, id) of the
    // last row on page 1. `id` is compared ascending even though createdAt is
    // descending, because the tiebreaker breaks ties within one createdAt.
    const boundary = new Date(EPOCH - 1 * 86_400_000)
    expect(queryFor(1).where.OR).toEqual([
      { createdAt: { lt: boundary } },
      { createdAt: boundary, id: { gt: "opportunity-2" } },
    ])
    expect(queryFor(1).where.workspaceId).toBe("workspace-1")
    // Page 2 continues the running count rather than restarting at 1.
    expect(page2.content[0].text).toContain("Showing 3-4 of 139.")
    const items = (page2.structuredContent.data as { items: { id: string }[] }).items
    expect(items.map((i) => i.id)).toEqual(["opportunity-3", "opportunity-4"])
  })

  it("flips the keyset comparison for an ascending sort", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(10)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(2))
    const page1 = await getHandler("list_opportunities")({
      workspaceId: "workspace-1",
      limit: 1,
      sort: "leastRecentlyUpdated",
    })
    const cursor = (page1.structuredContent.data as { nextCursor: string }).nextCursor

    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(1, 1))
    await getHandler("list_opportunities")({
      workspaceId: "workspace-1",
      limit: 1,
      sort: "leastRecentlyUpdated",
      cursor,
    })

    // Ascending sort walks forward, and the bound is on updatedAt (the key the
    // recency ordering actually sorts by), not createdAt.
    expect(queryFor(1).where.OR).toEqual([
      { updatedAt: { gt: new Date(EPOCH) } },
      { updatedAt: new Date(EPOCH), id: { gt: "opportunity-1" } },
    ])
  })

  it("reports the end of a walk as success rather than as no results", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(4)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(3))
    const page1 = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2 })
    const cursor = (page1.structuredContent.data as { nextCursor: string }).nextCursor

    // Paging off the end of a list whose final page was exactly full.
    mockPrisma.opportunity.findMany.mockResolvedValue([])
    const past = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2, cursor })

    expect(past.structuredContent.ok).toBe(true)
    // Not "Showing 4-4 of 4" — nothing is being shown, and claiming otherwise
    // would put a phantom item in an empty page.
    expect(past.content[0].text).toBe("No further items. All 4 have already been listed.")
    expect(past.content[0].text).not.toContain("No opportunities found")
    expect(past.structuredContent.data).toMatchObject({ items: [], count: 0, hasMore: false, nextCursor: null })
  })

  it("still reports a genuinely empty workspace as not-found", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(0)
    mockPrisma.opportunity.findMany.mockResolvedValue([])

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1" })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toBe("No opportunities found.")
  })

  it("omits the footer entirely when the whole listing fits in one page", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(2)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(2))

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1" })

    // Byte-identical to pre-pagination output for callers whose data fits.
    expect(result.content[0].text).not.toContain("Showing")
    expect(result.content[0].text.endsWith("ID: opportunity-2")).toBe(true)
  })

  it("rejects a malformed cursor instead of silently listing from the start", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(139)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(1))

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1", cursor: "not-a-cursor" })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("Invalid opportunity cursor")
    expect(mockPrisma.opportunity.findMany).not.toHaveBeenCalled()
  })

  it("refuses a cursor minted under different filters", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(139)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(3))
    const page1 = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2, status: "EXPLORING" })
    const cursor = (page1.structuredContent.data as { nextCursor: string }).nextCursor

    // Same cursor, different status filter: continuing would skip and repeat rows.
    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2, status: "ACTIVE", cursor })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("does not match the requested workspace, filters or sort")
    expect(mockPrisma.opportunity.findMany).toHaveBeenCalledTimes(1)
  })

  it("refuses a cursor minted against a different workspace", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(139)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(3))
    const page1 = await getHandler("list_opportunities")({ workspaceId: "workspace-1", limit: 2 })
    const cursor = (page1.structuredContent.data as { nextCursor: string }).nextCursor

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-2", limit: 2, cursor })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("does not match the requested workspace")
  })

  it("defaults to a 50-item page when limit is omitted", async () => {
    mockPrisma.opportunity.count.mockResolvedValue(139)
    mockPrisma.opportunity.findMany.mockResolvedValue(makeRows(51))

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1" })

    expect(queryFor(0).take).toBe(51)
    expect((result.structuredContent.data as { count: number }).count).toBe(50)
    expect(result.content[0].text).toContain("Showing 1-50 of 139.")
  })
})
