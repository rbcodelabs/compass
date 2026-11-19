import { beforeEach, describe, expect, it, vi } from "vitest"

const { tasksLinkedTo } = vi.hoisted(() => ({ tasksLinkedTo: vi.fn() }))
vi.mock("@/lib/task-links-read", () => ({ getTasksLinkedTo: tasksLinkedTo }))

import { MAX_ROADMAP_ITEMS, buildRoadmapOrderBy, buildRoadmapWhere, effectiveWorkspaceIds, loadCrossWorkspaceRoadmap } from "@/lib/roadmap-views/query"
import { DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS } from "@/lib/roadmap-views/schema"

describe("effectiveWorkspaceIds", () => {
  it("empty filter means everything readable", () => {
    expect(effectiveWorkspaceIds(["a", "b"], [])).toEqual(["a", "b"])
  })
  it("a filter can only narrow, never widen", () => {
    expect(effectiveWorkspaceIds(["a", "b"], ["b", "zzz"])).toEqual(["b"])
    expect(effectiveWorkspaceIds(["a"], ["zzz"])).toEqual([])
  })
})

describe("buildRoadmapWhere", () => {
  it("always scopes to the given workspaces and ACTIVE items", () => {
    const where = buildRoadmapWhere(["a"], DEFAULT_ROADMAP_FILTERS)
    expect(where).toEqual({ workspaceId: { in: ["a"] }, status: "ACTIVE" })
  })
  it("maps horizon, squad and link filters", () => {
    const where = buildRoadmapWhere(["a"], { ...DEFAULT_ROADMAP_FILTERS, horizons: ["NOW"], squadIds: ["s"], keyResult: "linked", solution: "unlinked" })
    expect(where.horizon).toEqual({ in: ["NOW"] })
    expect(where.squadId).toEqual({ in: ["s"] })
    expect(where.keyResultId).toEqual({ not: null })
    expect(where.solutionId).toBeNull()
  })
  it("builds overlap clauses for a date range, treating one-sided items as a single day", () => {
    const where = buildRoadmapWhere(["a"], { ...DEFAULT_ROADMAP_FILTERS, dateFrom: "2026-01-01", dateTo: "2026-01-31" })
    const and = where.AND as Array<{ OR: unknown[] }>
    expect(and).toHaveLength(2)
    expect(and[0].OR).toEqual([{ endDate: { gte: new Date("2026-01-01T00:00:00.000Z") } }, { endDate: null, startDate: { gte: new Date("2026-01-01T00:00:00.000Z") } }])
    expect(and[1].OR).toEqual([{ startDate: { lte: new Date("2026-01-31T23:59:59.999Z") } }, { startDate: null, endDate: { lte: new Date("2026-01-31T23:59:59.999Z") } }])
  })
})

describe("buildRoadmapOrderBy", () => {
  it("manual sort follows horizon then sortOrder", () => {
    expect(buildRoadmapOrderBy("manual")[0]).toEqual({ horizon: "asc" })
  })
  it("date sorts put undated items last", () => {
    expect(buildRoadmapOrderBy("startDate")[0]).toEqual({ startDate: { sort: "asc", nulls: "last" } })
    expect(buildRoadmapOrderBy("updated")).toEqual([{ updatedAt: "desc" }])
  })
})

describe("loadCrossWorkspaceRoadmap", () => {
  it("returns nothing without touching the db when no workspace is reachable", async () => {
    const db = new Proxy({}, { get() { throw new Error("db must not be used") } }) as never
    const out = await loadCrossWorkspaceRoadmap([], DEFAULT_ROADMAP_FILTERS, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out).toEqual({ items: [], truncated: false })
  })
  it("returns nothing when the filter names only unreadable workspaces", async () => {
    const db = new Proxy({}, { get() { throw new Error("db must not be used") } }) as never
    const out = await loadCrossWorkspaceRoadmap(["a"], { ...DEFAULT_ROADMAP_FILTERS, workspaceIds: ["zzz"] }, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out.items).toEqual([])
  })
  const row = (id: string, workspaceId = "a") => ({
    id, title: id, description: null, horizon: "NOW", sortOrder: 0, isPrivate: false, solutionId: null, keyResultId: null,
    opportunityId: null, experimentId: null, feedbackId: null, startDate: null, endDate: null, updatedAt: new Date("2026-01-01"),
    autoCreated: false, solution: null, keyResult: null, opportunity: null, experiment: null, feedback: null, squad: null,
    launchChecklist: null, workspaceId, workspace: { id: workspaceId, name: workspaceId, slug: workspaceId },
  })
  beforeEach(() => tasksLinkedTo.mockReset())
  const fakeDb = (rows: unknown[], links: unknown[] = []) => {
    const seen: { where?: unknown; take?: number } = {}
    tasksLinkedTo.mockResolvedValue(links)
    const db = {
      roadmapItem: { findMany: async (args: { where: unknown; take: number }) => { seen.where = args.where; seen.take = args.take; return rows } },
    } as never
    return { db, seen }
  }

  it("queries only the readable workspaces", async () => {
    const { db, seen } = fakeDb([row("r1", "b")])
    const out = await loadCrossWorkspaceRoadmap(["a", "b"], { ...DEFAULT_ROADMAP_FILTERS, workspaceIds: ["b", "zzz"] }, DEFAULT_ROADMAP_DISPLAY, db)
    expect((seen.where as { workspaceId: unknown }).workspaceId).toEqual({ in: ["b"] })
    // The delivery rollup is read from entity_links for the readable workspaces only.
    expect(tasksLinkedTo).toHaveBeenCalledWith(expect.anything(), { workspaceIds: ["b"], linkedType: "ROADMAP_ITEM", linkedIds: ["r1"] })
    expect(out.items.map((i) => i.workspace.slug)).toEqual(["b"])
  })

  it("flags truncation and drops the sentinel row", async () => {
    const rows = Array.from({ length: MAX_ROADMAP_ITEMS + 1 }, (_, i) => row(`r${i}`))
    const { db, seen } = fakeDb(rows)
    const out = await loadCrossWorkspaceRoadmap(["a"], DEFAULT_ROADMAP_FILTERS, DEFAULT_ROADMAP_DISPLAY, db)
    expect(seen.take).toBe(MAX_ROADMAP_ITEMS + 1)
    expect(out.truncated).toBe(true)
    expect(out.items).toHaveLength(MAX_ROADMAP_ITEMS)
  })

  const riskFilters = {
    ...DEFAULT_ROADMAP_FILTERS,
    fields: [{ key: "SELECT:status", values: ["at risk"] }],
  }
  const fieldFilterDb = (rows: ReturnType<typeof row>[], stored: { fieldId: string; objectId: string; value: string }[]) => {
    const defs = [
      { id: "d1", workspaceId: "a", name: "Status", fieldType: "SELECT", order: 0, options: [{ label: "At risk", value: "risk" }, { label: "On track", value: "ok" }], sharedOptionSet: null },
      { id: "d2", workspaceId: "b", name: "status", fieldType: "SELECT", order: 0, options: [{ label: "At Risk", value: "at_risk" }], sharedOptionSet: null },
      { id: "d3", workspaceId: "a", name: "Priority", fieldType: "SELECT", order: 1, options: [{ label: "High", value: "p1" }], sharedOptionSet: null },
    ]
    const findItems = vi.fn(async (args: {
      where: { id?: { in: string[] }; workspaceId: { in: string[] } }; skip?: number; take: number;
    }) => rows
      .filter((item) => args.where.workspaceId.in.includes(item.workspaceId) && (!args.where.id || args.where.id.in.includes(item.id)))
      .slice(args.skip ?? 0, (args.skip ?? 0) + args.take))
    const findValues = vi.fn(async (args: {
      where: { fieldId: { in: string[] }; objectId?: { in: string[] } }; take?: number;
    }) => stored.filter((value) =>
      args.where.fieldId.in.includes(value.fieldId) && (!args.where.objectId || args.where.objectId.in.includes(value.objectId)),
    ).slice(0, args.take))
    tasksLinkedTo.mockResolvedValue([])
    const db = {
      customFieldDefinition: { findMany: async () => defs },
      customFieldValue: { findMany: findValues },
      roadmapItem: { findMany: findItems },
    } as never
    return { db, findItems, findValues }
  }

  it("matches labels across readable workspaces while ignoring mismatched field and item workspaces", async () => {
    const { db } = fieldFilterDb([row("r1", "a"), row("r2", "b"), row("r3", "a"), row("r4", "private")], [
      { fieldId: "d1", objectId: "r1", value: "risk" },
      { fieldId: "d2", objectId: "r2", value: "at_risk" },
      { fieldId: "d2", objectId: "r3", value: "at_risk" },
      { fieldId: "d1", objectId: "r4", value: "risk" },
    ])
    const out = await loadCrossWorkspaceRoadmap(
      ["a", "b"], riskFilters,
      { ...DEFAULT_ROADMAP_DISPLAY, fields: ["SELECT:status"] }, db,
    )
    expect(out.items.map((item) => [item.id, item.fieldValues["SELECT:status"]?.[0].label])).toEqual([
      ["r1", "At risk"], ["r2", "At Risk"],
    ])
  })

  it("scopes and limits value reads while finding matches beyond the first 1,000 candidates", async () => {
    const rows = Array.from({ length: MAX_ROADMAP_ITEMS + 2 }, (_, i) => row(`r${i}`))
    const match = rows.at(-1)!.id
    const { db, findItems, findValues } = fieldFilterDb(rows, [{ fieldId: "d1", objectId: match, value: "risk" }])
    const out = await loadCrossWorkspaceRoadmap(["a"], riskFilters, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out.items.map((item) => item.id)).toEqual([match])
    expect(findValues.mock.calls.length).toBeGreaterThan(1)
    for (const [args] of findValues.mock.calls) {
      expect(args.where.objectId?.in.length).toBeLessThan(MAX_ROADMAP_ITEMS)
      expect(args.take).toBeGreaterThan(0)
    }
    expect(findItems.mock.calls[0][0].where).toEqual({ workspaceId: { in: ["a"] }, status: "ACTIVE" })
  })

  it("accepts either label within one field and requires a match in the other field", async () => {
    const { db } = fieldFilterDb([row("r1"), row("r2"), row("r3"), row("r4")], [
      { fieldId: "d1", objectId: "r1", value: "risk" },
      { fieldId: "d1", objectId: "r2", value: "ok" },
      { fieldId: "d1", objectId: "r3", value: "risk" },
      { fieldId: "d3", objectId: "r1", value: "p1" },
      { fieldId: "d3", objectId: "r2", value: "p1" },
      { fieldId: "d3", objectId: "r4", value: "p1" },
    ])
    const filters = {
      ...DEFAULT_ROADMAP_FILTERS,
      fields: [{ key: "SELECT:status", values: ["At Risk", "On track"] }, { key: "SELECT:priority", values: ["High"] }],
    }
    const out = await loadCrossWorkspaceRoadmap(["a"], filters, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out.items.map((item) => item.id)).toEqual(["r1", "r2"])
  })

  it("reports the display cap when more than 1,000 field matches are confirmed", async () => {
    const rows = Array.from({ length: 5_001 }, (_, i) => row(`r${i}`))
    const { db, findItems } = fieldFilterDb(rows, rows.map(({ id }) => ({ fieldId: "d1", objectId: id, value: "risk" })))
    const out = await loadCrossWorkspaceRoadmap(["a"], riskFilters, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out.items).toHaveLength(MAX_ROADMAP_ITEMS)
    expect(out.truncated).toBe(true)
    expect(out.fieldSearchIncomplete).toBeUndefined()
    const hydration = findItems.mock.calls.at(-1)![0]
    expect(hydration.where.id?.in).toHaveLength(MAX_ROADMAP_ITEMS + 1)
    expect(findItems.mock.calls).toHaveLength(6)
  })

  it("reports an incomplete search when the candidate budget is exhausted", async () => {
    const rows = Array.from({ length: 5_001 }, (_, i) => row(`r${i}`))
    const { db, findItems } = fieldFilterDb(rows, [])
    const out = await loadCrossWorkspaceRoadmap(["a"], riskFilters, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out).toEqual({ items: [], truncated: false, fieldSearchIncomplete: true })
    expect(findItems.mock.calls.length).toBeGreaterThan(1)
    expect(findItems.mock.calls.every(([args]) => (args.skip ?? 0) + args.take <= 5_001)).toBe(true)
  })

  it("reports an incomplete search instead of treating a partial field-value batch as complete", async () => {
    const { db, findValues } = fieldFilterDb([row("r")], [])
    findValues.mockImplementation(async ({ take }) => Array.from({ length: take ?? 20_001 }, (_, i) => ({
      fieldId: `definition-${i}`, objectId: "r", value: "risk",
    })))
    const out = await loadCrossWorkspaceRoadmap(["a"], riskFilters, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out).toEqual({ items: [], truncated: false, fieldSearchIncomplete: true })
    expect(findValues).toHaveBeenCalledTimes(1)
    expect(findValues.mock.calls[0][0].take).toBe(20_001)
  })

  it("returns nothing, without querying items, when a field filter matches no item", async () => {
    const db = {
      customFieldDefinition: { findMany: async () => [] },
      customFieldValue: { findMany: async () => [] },
      roadmapItem: { findMany: async () => { throw new Error("items must not be queried") } },
    } as never
    const out = await loadCrossWorkspaceRoadmap(["a"], { ...DEFAULT_ROADMAP_FILTERS, fields: [{ key: "SELECT:status", values: ["x"] }] }, DEFAULT_ROADMAP_DISPLAY, db)
    expect(out).toEqual({ items: [], truncated: false })
  })

  it("applies the derived delivery-status filter in memory", async () => {
    const links = [{ linkedId: "r1", task: { status: "BLOCKED" } }]
    const { db } = fakeDb([row("r1"), row("r2")], links)
    const all = await loadCrossWorkspaceRoadmap(["a"], DEFAULT_ROADMAP_FILTERS, DEFAULT_ROADMAP_DISPLAY, db)
    const blocked = all.items.find((i) => i.id === "r1")!.deliveryStatus
    const filtered = await loadCrossWorkspaceRoadmap(["a"], { ...DEFAULT_ROADMAP_FILTERS, deliveryStatuses: [blocked] }, DEFAULT_ROADMAP_DISPLAY, db)
    expect(filtered.items.map((i) => i.id)).toEqual(["r1"])
    expect(all.items.find((i) => i.id === "r2")!.deliveryStatus).not.toBe(blocked)
  })
})
