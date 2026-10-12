import { describe, expect, it } from "vitest"
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
  const fakeDb = (rows: unknown[], links: unknown[] = []) => {
    const seen: { where?: unknown; take?: number; linkWhere?: unknown } = {}
    const db = {
      roadmapItem: { findMany: async (args: { where: unknown; take: number }) => { seen.where = args.where; seen.take = args.take; return rows } },
      taskLink: { findMany: async (args: { where: unknown }) => { seen.linkWhere = args.where; return links } },
    } as never
    return { db, seen }
  }

  it("queries only the readable workspaces", async () => {
    const { db, seen } = fakeDb([row("r1", "b")])
    const out = await loadCrossWorkspaceRoadmap(["a", "b"], { ...DEFAULT_ROADMAP_FILTERS, workspaceIds: ["b", "zzz"] }, DEFAULT_ROADMAP_DISPLAY, db)
    expect((seen.where as { workspaceId: unknown }).workspaceId).toEqual({ in: ["b"] })
    expect((seen.linkWhere as { task: unknown }).task).toEqual({ workspaceId: { in: ["b"] } })
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
