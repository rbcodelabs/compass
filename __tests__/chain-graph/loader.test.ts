/**
 * Tenant isolation for the chain graph loader: a two-workspace fake where every table is filtered the way the real queries
 * are (where.workspaceId, or `in` ids derived from already-scoped rows). Workspace A's graph must contain no B node or edge,
 * including a B solution whose FK points at an A opportunity and a NULL-workspace solution.
 */
import { describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

vi.mock("@/lib/typed-links", () => ({
  getCanvasLinkRows: async () => ({ opportunityObjective: [], solutionKeyResult: [] }),
  getOpportunityKeyResultPointers: async (_p: unknown, _w: string, opps: Array<{ id: string; linkedKeyResultId: string | null }>) =>
    new Map(opps.map((o) => [o.id, o.linkedKeyResultId])),
  getLinkedKeyResultsBySolution: async () => new Map(),
  getLinkedObjectivesByOpportunity: async () => new Map(),
}))

import { loadChainGraph } from "@/lib/chain-graph/loader"

const A = "ws-a"
const B = "ws-b"
type Row = Record<string, unknown> & { id: string; workspaceId?: string | null }

function table(rows: Row[]) {
  return {
    findMany: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      rows.filter((r) =>
        Object.entries(where).every(([k, v]) => {
          if (k === "status") return r.status === v
          if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: string[] }).in).includes(r[k] as string)
          return r[k] === v
        }),
      ),
  }
}

function fakePrisma(): AppPrismaClient {
  const stamp = { sortOrder: 0, createdAt: new Date(0) }
  return {
    squad: table([]),
    objective: table([
      { id: "oa", workspaceId: A, title: "A obj", status: "ON_TRACK", squadId: null, parentKeyResultId: null, ...stamp },
      { id: "ob", workspaceId: B, title: "B obj", status: "ON_TRACK", squadId: null, parentKeyResultId: null, ...stamp },
    ]),
    keyResult: table([
      { id: "ka", objectiveId: "oa", title: "k", current: 0, target: 1, unit: null, ...stamp },
      { id: "kb", objectiveId: "ob", title: "k", current: 0, target: 1, unit: null, ...stamp },
    ]),
    opportunity: table([
      { id: "pa", workspaceId: A, title: "A opp", status: "EXPLORING", squadId: null, linkedKeyResultId: "ka", ...stamp },
      { id: "pb", workspaceId: B, title: "B opp", status: "EXPLORING", squadId: null, linkedKeyResultId: "kb", ...stamp },
    ]),
    solution: table([
      { id: "sa", workspaceId: A, opportunityId: "pa", title: "A sol", status: "IDEA", ...stamp },
      { id: "sb", workspaceId: B, opportunityId: "pa", title: "B sol pointing at A opp", status: "IDEA", ...stamp },
      { id: "sn", workspaceId: null, opportunityId: "pa", title: "NULL-workspace sol", status: "IDEA", ...stamp },
    ]),
    assumption: table([
      { id: "xa", solutionId: "sa", title: "A assumption", riskLevel: "LOW", status: "UNTESTED", ...stamp },
      { id: "xb", solutionId: "sb", title: "B assumption", riskLevel: "LOW", status: "UNTESTED", ...stamp },
    ]),
    experiment: table([
      { id: "ea", workspaceId: A, assumptionId: "xa", title: "A exp", status: "RUNNING", squadId: null, conclusion: null, ...stamp },
      { id: "eb", workspaceId: B, assumptionId: "xa", title: "B exp pointing at A assumption", status: "RUNNING", squadId: null, conclusion: null, ...stamp },
    ]),
    roadmapItem: table([
      { id: "ra", workspaceId: A, status: "ACTIVE", title: "A rm", horizon: "NOW", squadId: null, solutionId: "sa", keyResultId: null, opportunityId: null, experimentId: null, feedback: null, ...stamp },
      { id: "rb", workspaceId: B, status: "ACTIVE", title: "B rm", horizon: "NOW", squadId: null, solutionId: "sa", keyResultId: null, opportunityId: null, experimentId: null, feedback: null, ...stamp },
    ]),
    canvasNodePosition: table([]),
  } as unknown as AppPrismaClient
}

describe("loadChainGraph tenant isolation", () => {
  it("returns only workspace A rows and no edge touching a B (or NULL-workspace) endpoint", async () => {
    const g = await loadChainGraph(fakePrisma(), A)
    const ids = g.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(["ea", "oa", "pa", "ra", "sa", "xa"])
    const keys = new Set(g.nodes.map((n) => n.key))
    expect(g.edges.length).toBeGreaterThan(0)
    for (const e of g.edges) expect(keys.has(e.from) && keys.has(e.to)).toBe(true)
  })

  it("is symmetric for workspace B", async () => {
    const g = await loadChainGraph(fakePrisma(), B)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["eb", "ob", "pb", "rb", "sb", "xb"])
    // B's solution points at A's opportunity: that cross-tenant edge must not exist
    expect(g.edges.some((e) => e.to === "SOLUTION:sb" || e.from === "OPPORTUNITY:pa")).toBe(false)
  })
})
