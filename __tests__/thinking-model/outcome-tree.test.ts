import { describe, expect, it } from "vitest"
import {
  buildOutcomeTree,
  type BuildOutcomeTreeInput,
  type OutcomeTree,
} from "@/lib/thinking-model/outcome-tree"

const objective = (id: string, sortOrder: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Objective ${id}`,
  status: "ON_TRACK",
  sortOrder,
  ...extra,
})
const keyResult = (id: string, objectiveId: string, sortOrder = 0) => ({
  id,
  objectiveId,
  title: `KR ${id}`,
  current: 5,
  target: 10,
  unit: null,
  sortOrder,
})
const opportunity = (id: string, sortOrder = 0, status = "EXPLORING") => ({ id, title: `Opp ${id}`, status, sortOrder })
const solution = (id: string, opportunityId: string, sortOrder = 0) => ({
  id,
  opportunityId,
  title: `Sol ${id}`,
  status: "DRAFT",
  sortOrder,
})

const empty: BuildOutcomeTreeInput = {
  objectives: [],
  keyResults: [],
  opportunities: [],
  solutions: [],
  objectiveOpportunityLinks: [],
  solutionKeyResultEdges: [],
  legacyPointers: [],
}
const build = (input: Partial<BuildOutcomeTreeInput>): OutcomeTree => buildOutcomeTree({ ...empty, ...input })

const childIds = (tree: OutcomeTree, objectiveId: string) =>
  tree.roots.find((r) => r.id === objectiveId)!.children.map((c) => `${c.opportunityId}:${c.placement}`)

describe("buildOutcomeTree (outcome-rooted)", () => {
  it("returns an empty tree for an empty workspace", () => {
    const tree = build({})
    expect(tree.shape).toBe("outcome-rooted")
    expect(tree.roots).toEqual([])
    expect(tree.pool).toEqual([])
    expect(tree.totals).toEqual({ objectives: 0, opportunities: 0, solutions: 0, pool: 0 })
  })

  it("roots on Objectives, children are linked Opportunities, each with its home Solutions", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
    })
    expect(childIds(tree, "o1")).toEqual(["p1:home"])
    expect(tree.opportunities.p1.solutionIds).toEqual(["s1"])
    expect(tree.pool).toEqual([])
  })

  it("shows Key Results as a metric strip, not as tree children", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      keyResults: [keyResult("k2", "o1", 1), keyResult("k1", "o1", 0)],
    })
    const root = tree.roots[0]
    expect(root.keyResults.map((k) => k.id)).toEqual(["k1", "k2"])
    expect(root.keyResults[0]).toMatchObject({ current: 5, target: 10, progress: 0.5 })
    expect(root.children).toEqual([])
  })

  it("clamps progress and reports null for a zero target", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      keyResults: [
        { ...keyResult("k1", "o1", 0), current: 30 },
        { ...keyResult("k2", "o1", 1), target: 0 },
      ],
    })
    expect(tree.roots[0].keyResults.map((k) => k.progress)).toEqual([1, null])
  })

  it("renders a multi-parent opportunity once under the first Objective by sort order, with stubs elsewhere", () => {
    const tree = build({
      // Input order is deliberately not sort order.
      objectives: [objective("o2", 1), objective("o1", 0), objective("o3", 2)],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [
        { objectiveId: "o3", opportunityId: "p1" },
        { objectiveId: "o2", opportunityId: "p1" },
        { objectiveId: "o1", opportunityId: "p1" },
      ],
    })
    expect(childIds(tree, "o1")).toEqual(["p1:home"])
    expect(childIds(tree, "o2")).toEqual(["p1:also"])
    expect(childIds(tree, "o3")).toEqual(["p1:also"])
    const stub = tree.roots.find((r) => r.id === "o2")!.children[0]
    expect(stub.homeObjective).toEqual({ id: "o1", title: "Objective o1" })
    expect(tree.roots.find((r) => r.id === "o1")!.children[0].homeObjective).toBeNull()
    // The subtree body exists once and is shared by the stubs (expandable).
    expect(Object.keys(tree.opportunities)).toEqual(["p1"])
  })

  it("counts each entity once in rollups and totals, even when stubs repeat", () => {
    const tree = build({
      objectives: [objective("o1", 0), objective("o2", 1)],
      opportunities: [opportunity("p1"), opportunity("p2"), opportunity("p3")],
      solutions: [solution("s1", "p1"), solution("s2", "p1"), solution("s3", "p2"), solution("s4", "p3")],
      objectiveOpportunityLinks: [
        { objectiveId: "o1", opportunityId: "p1" },
        { objectiveId: "o2", opportunityId: "p1" },
        { objectiveId: "o2", opportunityId: "p2" },
      ],
    })
    const [r1, r2] = tree.roots
    expect(r1.rollup).toEqual({ opportunities: 1, solutions: 2 })
    expect(r1.linkedOpportunityCount).toBe(1)
    // o2 links p1 (stub) and p2 (home): stub counts as linked but not in the rollup.
    expect(r2.linkedOpportunityCount).toBe(2)
    expect(r2.rollup).toEqual({ opportunities: 1, solutions: 1 })
    expect(tree.pool).toEqual(["p3"])
    const rolledOpps = tree.roots.reduce((n, r) => n + r.rollup.opportunities, 0) + tree.pool.length
    const rolledSols = tree.roots.reduce((n, r) => n + r.rollup.solutions, 0)
    expect(rolledOpps).toBe(tree.totals.opportunities)
    expect(rolledSols + 1 /* s4 is in the pool */).toBe(tree.totals.solutions)
  })

  it("puts unlinked, non-archived opportunities in the pool", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      opportunities: [opportunity("p1", 0), opportunity("p2", 1), opportunity("p3", 2, "ARCHIVED")],
      solutions: [solution("s2", "p2")],
      objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
    })
    expect(tree.pool).toEqual(["p2"])
    expect(tree.opportunities.p2.solutionIds).toEqual(["s2"])
    expect(tree.totals.pool).toBe(1)
  })

  it("excludes archived opportunities everywhere, with their solutions", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      opportunities: [opportunity("p1", 0, "ARCHIVED")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
    })
    expect(tree.roots[0].children).toEqual([])
    expect(tree.pool).toEqual([])
    expect(tree.opportunities).toEqual({})
    expect(tree.solutions).toEqual({})
    expect(tree.totals.opportunities).toBe(0)
    expect(tree.totals.solutions).toBe(0)
  })

  it("renders a solution with no key result link and no chip", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      keyResults: [keyResult("k1", "o1")],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
    })
    expect(tree.solutions.s1.krChips).toEqual([])
  })

  it("chips a solution once per key result it targets", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      keyResults: [keyResult("k1", "o1", 0), keyResult("k2", "o1", 1)],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
      solutionKeyResultEdges: [
        { solutionId: "s1", keyResultId: "k2" },
        { solutionId: "s1", keyResultId: "k1" },
        { solutionId: "s1", keyResultId: "k1" },
      ],
    })
    expect(tree.solutions.s1.krChips.map((c) => [c.keyResultId, c.crossOutcome])).toEqual([
      ["k1", false],
      ["k2", false],
    ])
  })

  it("marks a chip cross-outcome when the key result sits under an Objective the opportunity is not linked to, and never hides it", () => {
    const tree = build({
      objectives: [objective("o1", 0), objective("o2", 1)],
      keyResults: [keyResult("k1", "o1"), keyResult("k2", "o2")],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
      solutionKeyResultEdges: [
        { solutionId: "s1", keyResultId: "k1" },
        { solutionId: "s1", keyResultId: "k2" },
      ],
    })
    const chips = tree.solutions.s1.krChips
    expect(chips).toEqual([
      expect.objectContaining({ keyResultId: "k1", objectiveId: "o1", objectiveTitle: "Objective o1", crossOutcome: false }),
      expect.objectContaining({ keyResultId: "k2", objectiveId: "o2", objectiveTitle: "Objective o2", crossOutcome: true }),
    ])
  })

  it("treats every chip on a pool opportunity as cross-outcome", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      keyResults: [keyResult("k1", "o1")],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      solutionKeyResultEdges: [{ solutionId: "s1", keyResultId: "k1" }],
    })
    expect(tree.pool).toEqual(["p1"])
    expect(tree.solutions.s1.krChips[0].crossOutcome).toBe(true)
  })

  it("ignores links whose endpoint is not in the workspace data (hidden, drifted or NULL rows)", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      keyResults: [keyResult("k1", "o1")],
      opportunities: [opportunity("p1")],
      solutions: [solution("s1", "p1")],
      objectiveOpportunityLinks: [
        { objectiveId: "ghost-objective", opportunityId: "p1" },
        { objectiveId: "o1", opportunityId: "ghost-opportunity" },
      ],
      solutionKeyResultEdges: [
        { solutionId: "s1", keyResultId: "ghost-kr" },
        { solutionId: "ghost-solution", keyResultId: "k1" },
      ],
    })
    expect(tree.roots[0].children).toEqual([])
    expect(tree.pool).toEqual(["p1"])
    expect(tree.solutions.s1.krChips).toEqual([])
  })

  it("dedupes repeated link rows", () => {
    const tree = build({
      objectives: [objective("o1", 0)],
      opportunities: [opportunity("p1")],
      objectiveOpportunityLinks: [
        { objectiveId: "o1", opportunityId: "p1" },
        { objectiveId: "o1", opportunityId: "p1" },
      ],
    })
    expect(tree.roots[0].children).toHaveLength(1)
    expect(tree.roots[0].linkedOpportunityCount).toBe(1)
  })

  describe("legacy pointer fallback", () => {
    it("places an opportunity under its key result's Objective when no link row exists", () => {
      const tree = build({
        objectives: [objective("o1", 0)],
        keyResults: [keyResult("k1", "o1")],
        opportunities: [opportunity("p1")],
        legacyPointers: [{ opportunityId: "p1", keyResultId: "k1" }],
      })
      expect(childIds(tree, "o1")).toEqual(["p1:home"])
      expect(tree.pool).toEqual([])
      expect(tree.opportunities.p1.viaLegacyPointer).toBe(true)
    })

    it("does not apply when the opportunity has a link row (link rows win)", () => {
      const tree = build({
        objectives: [objective("o1", 0), objective("o2", 1)],
        keyResults: [keyResult("k2", "o2")],
        opportunities: [opportunity("p1")],
        objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
        legacyPointers: [{ opportunityId: "p1", keyResultId: "k2" }],
      })
      expect(childIds(tree, "o1")).toEqual(["p1:home"])
      expect(childIds(tree, "o2")).toEqual([])
      expect(tree.opportunities.p1.viaLegacyPointer).toBe(false)
    })

    it("falls through to the pool when the pointer's key result is not in the workspace data", () => {
      const tree = build({
        objectives: [objective("o1", 0)],
        opportunities: [opportunity("p1")],
        legacyPointers: [{ opportunityId: "p1", keyResultId: "missing" }],
      })
      expect(tree.pool).toEqual(["p1"])
    })
  })

  describe("cycles and supporting outcomes", () => {
    it("renders cycle-less objectives normally and chips only cycle-bound ones", () => {
      const tree = build({
        objectives: [
          objective("o1", 0),
          objective("o2", 1, { cycle: { id: "c1", title: "Q3" } }),
          objective("o3", 2, { cycle: null }),
        ],
      })
      expect(tree.roots.map((r) => r.cycle)).toEqual([null, { id: "c1", title: "Q3" }, null])
    })

    it("marks a child objective with a supporting-outcome chip and does not nest it", () => {
      const tree = build({
        objectives: [objective("parent", 0), objective("child", 1, { parentKeyResultId: "k1" })],
        keyResults: [keyResult("k1", "parent")],
      })
      expect(tree.roots.map((r) => r.id)).toEqual(["parent", "child"])
      expect(tree.roots[0].supports).toBeNull()
      expect(tree.roots[1].supports).toEqual({
        keyResultId: "k1",
        keyResultTitle: "KR k1",
        objectiveId: "parent",
        objectiveTitle: "Objective parent",
      })
    })

    it("omits the chip when the parent key result is not in the workspace data", () => {
      const tree = build({ objectives: [objective("child", 0, { parentKeyResultId: "gone" })] })
      expect(tree.roots[0].supports).toBeNull()
    })
  })

  it("is deterministic: the same inputs in any order give the same tree", () => {
    const input: BuildOutcomeTreeInput = {
      objectives: [objective("o1", 0), objective("o2", 0), objective("o3", 1)],
      keyResults: [keyResult("k1", "o1", 0), keyResult("k2", "o1", 0)],
      opportunities: [opportunity("p1", 0), opportunity("p2", 0), opportunity("p3", 1)],
      solutions: [solution("s1", "p1", 0), solution("s2", "p1", 0), solution("s3", "p2", 5)],
      objectiveOpportunityLinks: [
        { objectiveId: "o1", opportunityId: "p1" },
        { objectiveId: "o1", opportunityId: "p2" },
        { objectiveId: "o2", opportunityId: "p1" },
      ],
      solutionKeyResultEdges: [
        { solutionId: "s1", keyResultId: "k2" },
        { solutionId: "s1", keyResultId: "k1" },
      ],
      legacyPointers: [{ opportunityId: "p3", keyResultId: "k1" }],
    }
    const reversed: BuildOutcomeTreeInput = {
      ...input,
      objectives: [...input.objectives].reverse(),
      keyResults: [...input.keyResults].reverse(),
      opportunities: [...input.opportunities].reverse(),
      solutions: [...input.solutions].reverse(),
      objectiveOpportunityLinks: [...input.objectiveOpportunityLinks].reverse(),
      solutionKeyResultEdges: [...input.solutionKeyResultEdges].reverse(),
      legacyPointers: [...input.legacyPointers].reverse(),
    }
    expect(buildOutcomeTree(reversed)).toEqual(buildOutcomeTree(input))
  })

  it("orders by sortOrder, then createdAt, then id", () => {
    const tree = build({
      objectives: [
        objective("b", 0, { createdAt: 2 }),
        objective("a", 0, { createdAt: 2 }),
        objective("c", 0, { createdAt: 1 }),
        objective("d", -1),
      ],
    })
    expect(tree.roots.map((r) => r.id)).toEqual(["d", "c", "a", "b"])
  })
})

describe("buildOutcomeTree (objective-rooted-pool, OPPORTUNITY_FIRST_OKR)", () => {
  const input: Partial<BuildOutcomeTreeInput> = {
    shape: "objective-rooted-pool",
    objectives: [objective("o1", 0)],
    keyResults: [keyResult("k1", "o1", 0), keyResult("k2", "o1", 1)],
    opportunities: [opportunity("p1"), opportunity("pool-opp", 1)],
    solutions: [solution("s1", "p1"), solution("s2", "p1"), solution("s3", "pool-opp")],
    objectiveOpportunityLinks: [{ objectiveId: "o1", opportunityId: "p1" }],
    solutionKeyResultEdges: [{ solutionId: "s1", keyResultId: "k1" }],
  }

  it("derives pool -> Objective -> Key Result -> Solution", () => {
    const tree = build(input)
    expect(tree.shape).toBe("objective-rooted-pool")
    expect(tree.pool).toEqual(["pool-opp"])
    const root = tree.roots[0]
    expect(root.keyResults.map((k) => [k.id, k.solutionIds])).toEqual([
      ["k1", ["s1"]],
      ["k2", []],
    ])
    // s2 belongs to a linked opportunity but targets no key result of this objective.
    expect(root.looseSolutionIds).toEqual(["s2"])
  })

  it("does not fill the key result solution lists for the outcome-rooted shape", () => {
    const tree = build({ ...input, shape: "outcome-rooted" })
    expect(tree.roots[0].keyResults.every((k) => k.solutionIds.length === 0)).toBe(true)
    expect(tree.roots[0].looseSolutionIds).toEqual([])
  })

  it("lists a cross-outcome solution under the key result it targets", () => {
    const tree = build({
      ...input,
      solutionKeyResultEdges: [{ solutionId: "s3", keyResultId: "k2" }],
    })
    expect(tree.roots[0].keyResults.find((k) => k.id === "k2")!.solutionIds).toEqual(["s3"])
    expect(tree.solutions.s3.krChips[0].crossOutcome).toBe(true)
  })
})
