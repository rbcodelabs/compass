import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => {
  const model = () => ({ findMany: vi.fn().mockResolvedValue([]) })
  return {
    db: {
      opportunity: model(), solution: model(), experiment: model(), task: model(),
      doc: model(), objective: model(), keyResult: model(), metricRevision: model(), metricDefinition: model(),
      assumption: model(), roadmapItem: model(),
    },
    listDashboardMetrics: vi.fn(),
  }
})
vi.mock("@/lib/db", () => ({ default: () => m.db }))
vi.mock("@/lib/analytics/service", () => ({ listDashboardMetrics: m.listDashboardMetrics }))

import { resolveCanvasCards, searchCanvasCardTargets } from "@/lib/canvas-card-data"

const WS = { workspaceId: "ws-1", orgSlug: "org", workspaceSlug: "ws", userId: "user-1" }
const A = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f"
const B = "7f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f"

beforeEach(() => {
  vi.clearAllMocks()
  for (const model of Object.values(m.db)) model.findMany.mockResolvedValue([])
  m.listDashboardMetrics.mockResolvedValue([])
})

describe("resolveCanvasCards", () => {
  it("returns live data for objects in the canvas's workspace and scopes every query to it", async () => {
    m.db.opportunity.findMany.mockResolvedValue([{ id: A, title: "Churn", status: "EXPLORING", customerSegment: "SMB", score: { normalizedScore: 72.4 } }])
    const result = await resolveCanvasCards({ ...WS, refs: [{ kind: "opportunity", id: A }] })
    expect(result[`opportunity:${A}`]).toMatchObject({ state: "ok", title: "Churn", status: "EXPLORING", facts: [{ label: "Score", value: "72%" }, { label: "Segment", value: "SMB" }] })
    expect(m.db.opportunity.findMany.mock.calls[0][0].where).toEqual({ id: { in: [A] }, workspaceId: "ws-1" })
  })

  it("an id from another workspace is unavailable and leaks nothing (not-found == forbidden)", async () => {
    // The scoped query returns nothing for foreign ids.
    const result = await resolveCanvasCards({ ...WS, refs: [{ kind: "task", id: A }, { kind: "doc", id: B }] })
    expect(result[`task:${A}`]).toEqual({ state: "unavailable", kind: "task", id: A })
    expect(result[`doc:${B}`]).toEqual({ state: "unavailable", kind: "doc", id: B })
    expect(JSON.stringify(result)).not.toMatch(/title|status|href/)
    expect(m.db.task.findMany.mock.calls[0][0].where.workspaceId).toBe("ws-1")
    expect(m.db.doc.findMany.mock.calls[0][0].where.workspaceId).toBe("ws-1")
  })

  it("scopes key results through their objective and solutions by their own workspace", async () => {
    await resolveCanvasCards({ ...WS, refs: [{ kind: "keyResult", id: A }, { kind: "solution", id: B }] })
    expect(m.db.keyResult.findMany.mock.calls[0][0].where).toEqual({ id: { in: [A] }, objective: { workspaceId: "ws-1" } })
    expect(m.db.solution.findMany.mock.calls[0][0].where).toEqual({ id: { in: [B] }, workspaceId: "ws-1" })
  })

  it("ignores invalid kinds/ids without touching the database, and dedupes", async () => {
    const result = await resolveCanvasCards({
      ...WS,
      refs: [{ kind: "workspace", id: A }, { kind: "doc", id: "not-a-uuid" }, null, "x", { kind: "doc", id: A }, { kind: "doc", id: A.toUpperCase() }],
    })
    expect(Object.keys(result)).toEqual([`doc:${A}`])
    expect(m.db.doc.findMany).toHaveBeenCalledTimes(1)
    expect(m.db.doc.findMany.mock.calls[0][0].where.id.in).toEqual([A])
    expect(m.db.opportunity.findMany).not.toHaveBeenCalled()
  })

  it("renders metric latest value and trend, and degrades to unavailable when analytics refuses the viewer", async () => {
    m.listDashboardMetrics.mockResolvedValue([
      { metric: { id: A, name: "Weekly actives", unit: "users" }, status: "fresh", statusCaption: "Updated today", value: 1200, delta: { direction: "up", diff: 50 }, sparkline: [] },
      { metric: { id: B, name: "Other", unit: "x" }, status: "fresh", statusCaption: "", value: 1, delta: null, sparkline: [] },
    ])
    const ok = await resolveCanvasCards({ ...WS, refs: [{ kind: "metric", id: A }] })
    expect(ok[`metric:${A}`]).toMatchObject({ state: "ok", title: "Weekly actives", facts: [{ label: "Latest", value: "1,200 users" }, { label: "Trend", value: "Up 50" }, { label: "Freshness", value: "Updated today" }] })
    expect(Object.keys(ok)).toEqual([`metric:${A}`])
    expect(m.listDashboardMetrics).toHaveBeenCalledWith({ userId: "user-1", purpose: "USER", scopeWorkspaceId: "ws-1" }, "ws-1")

    m.listDashboardMetrics.mockRejectedValue(new Error("ACCESS_DENIED"))
    const denied = await resolveCanvasCards({ ...WS, refs: [{ kind: "metric", id: A }] })
    expect(denied[`metric:${A}`]).toEqual({ state: "unavailable", kind: "metric", id: A })
  })

  it("computes objective progress from its key results", async () => {
    m.db.objective.findMany.mockResolvedValue([{ id: A, title: "Grow", status: "ON_TRACK", owner: "Ana", keyResults: [{ current: 5, target: 10 }, { current: 10, target: 10 }] }])
    const result = await resolveCanvasCards({ ...WS, refs: [{ kind: "objective", id: A }] })
    expect(result[`objective:${A}`]).toMatchObject({ facts: [{ label: "Progress", value: "75%" }, { label: "Owner", value: "Ana" }] })
  })
})

describe("resolveCanvasCards: assumptions and roadmap items", () => {
  it("scopes assumptions through their solution and roadmap items by workspace", async () => {
    m.db.assumption.findMany.mockResolvedValue([{ id: A, title: "Risky", status: "UNTESTED", riskLevel: "HIGH", solution: { opportunityId: "opp-1", title: "Fix" } }])
    m.db.roadmapItem.findMany.mockResolvedValue([{ id: B, title: "Ship it", status: "ACTIVE", horizon: "NOW" }])
    const result = await resolveCanvasCards({ ...WS, refs: [{ kind: "assumption", id: A }, { kind: "roadmapItem", id: B }] })
    expect(m.db.assumption.findMany.mock.calls[0][0].where).toEqual({ id: { in: [A] }, solution: { workspaceId: "ws-1" } })
    expect(m.db.roadmapItem.findMany.mock.calls[0][0].where).toEqual({ id: { in: [B] }, workspaceId: "ws-1" })
    expect(result[`assumption:${A}`]).toMatchObject({ state: "ok", title: "Risky", facts: [{ label: "Risk", value: "HIGH" }, { label: "Solution", value: "Fix" }] })
    expect(result[`roadmapItem:${B}`]).toMatchObject({ state: "ok", facts: [{ label: "Horizon", value: "NOW" }] })
  })

  it("reports foreign ids as unavailable", async () => {
    const result = await resolveCanvasCards({ ...WS, refs: [{ kind: "assumption", id: A }] })
    expect(result[`assumption:${A}`]).toEqual({ state: "unavailable", kind: "assumption", id: A })
  })
})

describe("searchCanvasCardTargets", () => {
  it("scopes every kind to the workspace and orders by kind", async () => {
    m.db.task.findMany.mockResolvedValue([{ id: A, title: "Fix login", status: "TODO" }])
    m.db.opportunity.findMany.mockResolvedValue([{ id: B, title: "Login drop-off", status: "EXPLORING" }])
    const items = await searchCanvasCardTargets({ workspaceId: "ws-1", query: "login" })
    expect(items.map((i) => i.kind)).toEqual(["opportunity", "task"])
    expect(m.db.opportunity.findMany.mock.calls[0][0].where.workspaceId).toBe("ws-1")
    expect(m.db.keyResult.findMany.mock.calls[0][0].where.objective).toEqual({ workspaceId: "ws-1" })
    expect(m.db.metricRevision.findMany.mock.calls[0][0].where.workspaceId).toBe("ws-1")
    expect(m.db.assumption.findMany.mock.calls[0][0].where.solution).toEqual({ workspaceId: "ws-1" })
    expect(m.db.roadmapItem.findMany.mock.calls[0][0].where.workspaceId).toBe("ws-1")
  })

  it("finds assumptions and roadmap items after the core kinds", async () => {
    m.db.assumption.findMany.mockResolvedValue([{ id: A, title: "Users log in weekly", status: "UNTESTED" }])
    m.db.roadmapItem.findMany.mockResolvedValue([{ id: B, title: "Login revamp", horizon: "NOW" }])
    const items = await searchCanvasCardTargets({ workspaceId: "ws-1", query: "log" })
    expect(items).toEqual([
      { kind: "assumption", id: A, title: "Users log in weekly", context: "UNTESTED" },
      { kind: "roadmapItem", id: B, title: "Login revamp", context: "NOW" },
    ])
  })

  it("only offers metrics whose current revision matches", async () => {
    m.db.metricRevision.findMany.mockResolvedValue([{ id: "rev-old", metricId: A, name: "Old name" }, { id: "rev-cur", metricId: B, name: "MRR" }])
    m.db.metricDefinition.findMany.mockResolvedValue([{ id: B, currentRevisionId: "rev-cur" }])
    const items = await searchCanvasCardTargets({ workspaceId: "ws-1", query: "m" })
    expect(items).toEqual([{ kind: "metric", id: B, title: "MRR" }])
  })

  it("rejects empty or oversized queries without querying", async () => {
    expect(await searchCanvasCardTargets({ workspaceId: "ws-1", query: " " })).toEqual([])
    expect(await searchCanvasCardTargets({ workspaceId: "ws-1", query: "x".repeat(101) })).toEqual([])
    expect(m.db.doc.findMany).not.toHaveBeenCalled()
  })
})
