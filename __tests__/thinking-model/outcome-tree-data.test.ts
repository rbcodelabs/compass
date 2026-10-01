import { describe, expect, it, vi } from "vitest"
import { loadOutcomeTree, loadOutcomeTreeInput } from "@/lib/thinking-model/outcome-tree-data"
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

/**
 * The loader runs against the shared two-tenant fake, which models the NULL-workspace
 * Solution/Objective rows (rows that predate the 068 backfill) and a second workspace.
 */
function setup() {
  const fake = createTenantFakePrisma()
  const link = (store: Record<string, unknown>[], row: Record<string, unknown>) =>
    store.push({ id: `l-${store.length}`, source: "UI", createdById: null, createdAt: new Date(10 + store.length), ...row })
  return { fake, db: fake.client as never, link }
}

describe("loadOutcomeTreeInput (tenant scoping)", () => {
  it("returns only the workspace's own rows and hides NULL-workspace Solutions and Objectives", async () => {
    const { db } = setup()
    const input = await loadOutcomeTreeInput(db, WS_A.id)
    expect(input.objectives.map((o) => o.id)).toEqual(["obj-a"])
    expect(input.keyResults.map((k) => k.id)).toEqual(["kr-a"])
    expect(input.opportunities.map((o) => o.id)).toEqual(["opp-a"])
    expect(input.solutions.map((s) => s.id)).toEqual(["sol-a"])
  })

  it("does not read the other workspace", async () => {
    const { db } = setup()
    const input = await loadOutcomeTreeInput(db, WS_B.id)
    expect(input.objectives.map((o) => o.id)).toEqual(["obj-b"])
    expect(input.opportunities.map((o) => o.id)).toEqual(["opp-b"])
  })

  it("keeps a link only when BOTH endpoints are in the workspace (foreign, NULL and drifted endpoints are dropped)", async () => {
    const { fake, db, link } = setup()
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" })
    // A link row in A that points at B's objective, and at an unbackfilled objective.
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-b", origin: "DIRECT" })
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-null", origin: "DIRECT" })
    // A drifted row whose own workspaceId says B but names A's endpoints.
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_B.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" })
    link(fake.state.solutionKeyResultLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" })
    link(fake.state.solutionKeyResultLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-b" })
    link(fake.state.solutionKeyResultLinks, { workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-null" })

    const input = await loadOutcomeTreeInput(db, WS_A.id)
    expect(input.objectiveOpportunityLinks).toEqual([{ objectiveId: "obj-a", opportunityId: "opp-a" }])
    expect(input.solutionKeyResultEdges).toEqual([{ solutionId: "sol-a", keyResultId: "kr-a" }])
  })

  it("passes legacy pointers through and excludes archived opportunities at the query", async () => {
    const { fake, db } = setup()
    fake.state.opportunities[0].linkedKeyResultId = "kr-a"
    fake.state.opportunities.push({ ...fake.state.opportunities[0], id: "opp-archived", status: "ARCHIVED", linkedKeyResultId: null })
    const input = await loadOutcomeTreeInput(db, WS_A.id)
    expect(input.legacyPointers).toEqual([{ opportunityId: "opp-a", keyResultId: "kr-a" }])
    expect(input.opportunities.map((o) => o.id)).toEqual(["opp-a"])
  })

  it("shows a cycle chip only when the cycle is the workspace's own", async () => {
    const { fake, db } = setup()
    fake.state.objectives.push({ id: "obj-drift", workspaceId: WS_A.id, cycleId: "cycle-b", title: "Drifted cycle", status: "ON_TRACK", sortOrder: 1 })
    const input = await loadOutcomeTreeInput(db, WS_A.id)
    const byId = Object.fromEntries(input.objectives.map((o) => [o.id, o.cycle]))
    expect(byId["obj-a"]).toEqual({ id: "cycle-a", title: "A cycle" })
    expect(byId["obj-drift"]).toBeNull()
  })

  it("is read-only and filters every query by workspaceId (no unscoped read)", async () => {
    const { fake, db } = setup()
    const spies = ["objective", "oKRCycle", "keyResult", "opportunity", "solution"].map((model) =>
      vi.spyOn((fake.client as unknown as Record<string, { findMany: (a: { where: Record<string, unknown> }) => Promise<unknown> }>)[model], "findMany"),
    )
    await loadOutcomeTreeInput(db, WS_A.id)
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1)
      const where = spy.mock.calls[0][0].where
      expect(JSON.stringify(where)).toContain(WS_A.id)
    }
    expect(fake.state.writes).toEqual([])
  })

  it("issues one query per table, not one per row (no N+1)", async () => {
    const { fake, db } = setup()
    for (let i = 0; i < 40; i++) {
      fake.state.opportunities.push({ ...fake.state.opportunities[0], id: `opp-many-${i}` })
      fake.state.solutions.push({ ...fake.state.solutions[0], id: `sol-many-${i}`, opportunityId: `opp-many-${i}` })
    }
    const client = fake.client as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown> }>
    const counted = ["objective", "oKRCycle", "keyResult", "opportunity", "solution", "opportunityObjectiveLink", "solutionKeyResultLink"]
    const spies = counted.map((model) => vi.spyOn(client[model], "findMany"))
    await loadOutcomeTreeInput(db, WS_A.id)
    for (const spy of spies) expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
  })
})

describe("loadOutcomeTree", () => {
  it("builds the tree: linked opportunity under its objective, the rest in the pool", async () => {
    const { fake, db, link } = setup()
    fake.state.opportunities.push({ ...fake.state.opportunities[0], id: "opp-a2", title: "Unlinked", sortOrder: 1 })
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" })
    const tree = await loadOutcomeTree(db, WS_A.id)
    expect(tree.roots.map((r) => r.id)).toEqual(["obj-a"])
    expect(tree.roots[0].children).toEqual([{ opportunityId: "opp-a", placement: "home", homeObjective: null }])
    expect(tree.pool).toEqual(["opp-a2"])
  })
})
