import { describe, expect, it, vi } from "vitest"
import { loadOutcomeTree, loadOutcomeTreeInput, loadOutcomesIndex } from "@/lib/thinking-model/outcome-tree-data"
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
    const { fake, db, link } = setup()
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" })
    const spies = ["objective", "oKRCycle", "keyResult", "opportunity", "solution"].map((model) =>
      vi.spyOn((fake.client as unknown as Record<string, { findMany: (a: { where: Record<string, unknown> }) => Promise<unknown> }>)[model], "findMany"),
    )
    await loadOutcomeTreeInput(db, WS_A.id)
    // objective is read twice by design: the loader, then the link readers' title join (also workspace-filtered).
    spies.forEach((spy, index) => expect(spy).toHaveBeenCalledTimes(index === 0 ? 2 : 1))
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call[0].where)).toContain(WS_A.id)
    }
    expect(fake.state.writes).toEqual([])
  })

  it("issues one query per table, not one per row (no N+1)", async () => {
    const { fake, db, link } = setup()
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" })
    for (let i = 0; i < 40; i++) {
      fake.state.opportunities.push({ ...fake.state.opportunities[0], id: `opp-many-${i}` })
      fake.state.solutions.push({ ...fake.state.solutions[0], id: `sol-many-${i}`, opportunityId: `opp-many-${i}` })
    }
    const client = fake.client as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown> }>
    const counted = ["objective", "oKRCycle", "keyResult", "opportunity", "solution", "opportunityObjectiveLink", "solutionKeyResultLink"]
    const spies = counted.map((model) => vi.spyOn(client[model], "findMany"))
    await loadOutcomeTreeInput(db, WS_A.id)
    // 40 extra opportunities and solutions add no queries: at most one per table, two for objective (loader + link title join).
    for (const spy of spies) expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
    expect(spies[counted.indexOf("opportunity")].mock.calls.length).toBe(1)
    expect(spies[counted.indexOf("solution")].mock.calls.length).toBe(1)
    expect(spies[counted.indexOf("opportunityObjectiveLink")].mock.calls.length).toBe(1)
  })
})

describe("link reads with real links (chunking, no N+1)", () => {
  it("reads 1,201 linked opportunities in three link queries and a bounded number of objective queries, not one per row", async () => {
    const { fake, db, link } = setup()
    for (let i = 0; i < 1200; i++) {
      const id = `opp-bulk-${i}`
      fake.state.opportunities.push({ ...fake.state.opportunities[0], id, sortOrder: i + 1 })
      link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: id, objectiveId: "obj-a", origin: "DIRECT" })
    }
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" })
    const client = fake.client as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown> }>
    const linkReads = vi.spyOn(client.opportunityObjectiveLink, "findMany")
    const objectiveReads = vi.spyOn(client.objective, "findMany")
    const input = await loadOutcomeTreeInput(db, WS_A.id)
    expect(input.opportunities).toHaveLength(1201)
    expect(input.objectiveOpportunityLinks).toHaveLength(1201)
    // 1,201 ids in chunks of 500: three link reads, and one title read per chunk plus the loader's own.
    expect(linkReads).toHaveBeenCalledTimes(3)
    expect(objectiveReads.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe("link table missing (migration 071 not applied) fails loudly", () => {
  const missingTable = () => Object.assign(new Error("relation \"opportunity_objective_links\" does not exist"), { code: "42P01" })
  const breakLinkTables = (fake: ReturnType<typeof createTenantFakePrisma>) => {
    const client = fake.client as unknown as Record<string, { findMany: unknown }>
    client.opportunityObjectiveLink.findMany = async () => { throw missingTable() }
    client.solutionKeyResultLink.findMany = async () => { throw missingTable() }
  }

  it("the tree loader throws the database error instead of presenting every opportunity as unlinked", async () => {
    const { fake, db } = setup()
    breakLinkTables(fake)
    await expect(loadOutcomeTree(db, WS_A.id)).rejects.toMatchObject({ code: "42P01" })
  })

  it("the Outcomes index loader throws too, with no warning logged as a substitute", async () => {
    const { fake, db } = setup()
    breakLinkTables(fake)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(loadOutcomesIndex(db, WS_A.id)).rejects.toMatchObject({ code: "42P01" })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("a workspace with no links yet is simply empty, not an error", async () => {
    const { db } = setup()
    const tree = await loadOutcomeTree(db, WS_A.id)
    expect(tree.pool).toEqual(["opp-a"])
    expect((await loadOutcomesIndex(db, WS_A.id)).rows.map((r) => r.id)).toEqual(["obj-a"])
  })

  it("an empty workspace issues no link query, so it cannot fail on a missing table", async () => {
    const { fake, db } = setup()
    breakLinkTables(fake)
    fake.state.opportunities.length = 0
    fake.state.solutions.length = 0
    await expect(loadOutcomeTree(db, WS_A.id)).resolves.toMatchObject({ pool: [] })
  })
})

describe("loadOutcomesIndex (the lighter read)", () => {
  it("agrees with the tree on linked counts, including the legacy pointer fallback, and skips solutions", async () => {
    const { fake, db, link } = setup()
    fake.state.opportunities.push({ ...fake.state.opportunities[0], id: "opp-legacy", linkedKeyResultId: "kr-a", sortOrder: 1 })
    fake.state.opportunities.push({ ...fake.state.opportunities[0], id: "opp-b-links", sortOrder: 2 })
    fake.state.objectives.push({ id: "obj-a2", workspaceId: WS_A.id, cycleId: null, title: "A2", status: "ON_TRACK", sortOrder: 1 })
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" })
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-b-links", objectiveId: "obj-a", origin: "DIRECT" })
    link(fake.state.opportunityObjectiveLinks, { workspaceId: WS_A.id, opportunityId: "opp-b-links", objectiveId: "obj-a2", origin: "DIRECT" })
    const client = fake.client as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown> }>
    const solutionReads = vi.spyOn(client.solution, "findMany")
    const solutionLinkReads = vi.spyOn(client.solutionKeyResultLink, "findMany")
    const index = await loadOutcomesIndex(db, WS_A.id)
    const tree = await loadOutcomeTree(db, WS_A.id)
    expect(index.rows).toEqual(tree.roots.map((r) => ({ id: r.id, title: r.title, status: r.status, cycle: r.cycle, linkedOpportunityCount: r.linkedOpportunityCount })))
    expect(index.rows.find((r) => r.id === "obj-a")!.linkedOpportunityCount).toBe(3)
    expect(index.rows.find((r) => r.id === "obj-a2")!.cycle).toBeNull()
    // Only the full tree load read solutions (once each): the index read none.
    expect(solutionReads).toHaveBeenCalledTimes(1)
    expect(solutionLinkReads).toHaveBeenCalledTimes(1)
  })

  it("hides NULL-workspace objectives and is scoped to the workspace", async () => {
    const { db } = setup()
    expect((await loadOutcomesIndex(db, WS_A.id)).rows.map((r) => r.id)).toEqual(["obj-a"])
    expect((await loadOutcomesIndex(db, WS_B.id)).rows.map((r) => r.id)).toEqual(["obj-b"])
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
