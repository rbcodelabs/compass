import { describe, expect, it } from "vitest"
import { buildOpportunityChain, CHAIN_TASK_CAP, type OSTOpportunityNode } from "@/lib/thinking-model/opportunity-chain"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

const model = (source: Parameters<typeof resolveThinkingModel>[0]) => {
  const resolved = resolveThinkingModel(source)
  return { links: resolved.links, tree: resolved.tree }
}
const CLASSIC = model({})
const OFO = model({ thinkingModel: "OPPORTUNITY_FIRST_OKR" })
const TORRES = model({ thinkingModel: "TORRES_OST" })

const solution = (id: string, extra: Partial<OSTOpportunityNode["solutions"][number]> = {}) => ({
  id,
  title: `Sol ${id}`,
  status: "IDEA" as const,
  assumptions: [],
  ...extra,
})

const opp = (extra: Partial<OSTOpportunityNode> = {}): OSTOpportunityNode => ({
  id: "o1",
  title: "Opp",
  status: "EXPLORING",
  linkedKeyResult: { id: "kr-legacy", title: "Legacy KR", objective: { id: "obj-legacy", title: "Legacy objective" } },
  linkedObjectives: [
    { id: "obj-a", title: "Objective A" },
    { id: "obj-b", title: "Objective B" },
  ],
  chainObjectives: [
    { id: "obj-a", title: "Objective A", keyResults: [{ id: "kr-a1", title: "A1", current: 5, target: 10, unit: null }, { id: "kr-a2", title: "A2", current: 0, target: 0 }] },
    { id: "obj-b", title: "Objective B", keyResults: [] },
    { id: "obj-legacy", title: "Legacy objective", keyResults: [] },
  ],
  solutions: [solution("s1", { linkedKeyResults: [{ id: "kr-a1", title: "A1", objectiveId: "obj-a" }, { id: "kr-x", title: "X", objectiveId: "obj-x" }] })],
  ...extra,
})

describe("buildOpportunityChain", () => {
  describe("CLASSIC (kr-rooted)", () => {
    it("roots at the legacy Key Result with its Objective title; typed links and chips are hidden", () => {
      const chain = buildOpportunityChain(opp(), CLASSIC)
      expect(chain.parents).toEqual([
        { kind: "keyResult", id: "kr-legacy", title: "Legacy KR", objective: { id: "obj-legacy", title: "Legacy objective" } },
      ])
      expect(chain.opportunity.solutions[0].krChips).toEqual([])
      expect(chain.legend.slice(0, 1)).toEqual(["root"])
    })

    it("has no parent when there is no Key Result: the opportunity is the root, typed Objectives are ignored", () => {
      expect(buildOpportunityChain(opp({ linkedKeyResult: null }), CLASSIC).parents).toEqual([])
    })

    it("keeps an Objective without an id (payload predating the id) as title only", () => {
      const chain = buildOpportunityChain(opp({ linkedKeyResult: { id: "k", title: "K", objective: { title: "O" } } }), CLASSIC)
      expect(chain.parents[0]).toMatchObject({ kind: "keyResult", objective: { id: null, title: "O" } })
    })
  })

  describe("OPPORTUNITY_FIRST_OKR (objective-rooted-pool)", () => {
    it("shows every linked Objective once as a parent, above one opportunity subtree", () => {
      const chain = buildOpportunityChain(opp(), OFO)
      expect(chain.parents.map((p) => p.kind === "objective" && p.id)).toEqual(["obj-a", "obj-b", "obj-legacy"])
      expect(chain.opportunity.solutions).toHaveLength(1)
    })

    it("keeps the legacy Key Result as a secondary node under its own Objective, even one the links do not name", () => {
      const chain = buildOpportunityChain(opp(), OFO)
      const legacy = chain.parents.find((p) => p.kind === "objective" && p.id === "obj-legacy")
      expect(legacy).toMatchObject({ keyResults: [{ id: "kr-legacy", emphasis: "secondary" }] })
      const a = chain.parents.find((p) => p.kind === "objective" && p.id === "obj-a")
      expect(a).toMatchObject({ keyResults: [] })
    })

    it("draws no metric strip", () => {
      const chain = buildOpportunityChain(opp(), OFO)
      expect(chain.parents.every((p) => p.kind === "objective" && p.metrics.length === 0)).toBe(true)
    })

    it("marks a chip cross-outcome when its Key Result's Objective is not a parent", () => {
      const chips = buildOpportunityChain(opp(), OFO).opportunity.solutions[0].krChips
      expect(chips).toEqual([
        { id: "kr-a1", title: "A1", crossOutcome: false, objectiveTitle: "Objective A" },
        { id: "kr-x", title: "X", crossOutcome: true, objectiveTitle: null },
      ])
    })

    it("falls back to the legacy pointer's Objective when no link row exists", () => {
      const chain = buildOpportunityChain(opp({ linkedObjectives: [] }), OFO)
      expect(chain.parents).toHaveLength(1)
      expect(chain.parents[0]).toMatchObject({ kind: "objective", id: "obj-legacy", keyResults: [{ id: "kr-legacy" }] })
    })

    it("dedupes repeated links", () => {
      const chain = buildOpportunityChain(opp({ linkedObjectives: [{ id: "obj-a", title: "Objective A" }, { id: "obj-a", title: "Objective A" }] }), OFO)
      expect(chain.parents.filter((p) => p.kind === "objective" && p.id === "obj-a")).toHaveLength(1)
    })
  })

  describe("TORRES_OST (outcome-rooted)", () => {
    it("roots at the Outcomes, with Key Results as a compact metric strip rather than tree nodes", () => {
      const chain = buildOpportunityChain(opp(), TORRES)
      const a = chain.parents.find((p) => p.kind === "objective" && p.id === "obj-a")
      expect(a).toMatchObject({
        keyResults: [],
        metrics: [
          { id: "kr-a1", progress: 0.5 },
          { id: "kr-a2", progress: null },
        ],
      })
    })

    it("hides the legacy Key Result level but still uses its Objective as the fallback parent", () => {
      const chain = buildOpportunityChain(opp({ linkedObjectives: [] }), TORRES)
      expect(chain.parents).toHaveLength(1)
      expect(chain.parents[0]).toMatchObject({ kind: "objective", id: "obj-legacy", keyResults: [] })
      expect(JSON.stringify(chain.parents)).not.toContain("Legacy KR")
    })

    it("carries chips on solutions", () => {
      expect(buildOpportunityChain(opp(), TORRES).opportunity.solutions[0].krChips.map((c) => c.id)).toEqual(["kr-a1", "kr-x"])
    })

    it("a pool opportunity (no link, no pointer) has no parents and every chip is cross-outcome", () => {
      const chain = buildOpportunityChain(opp({ linkedObjectives: [], linkedKeyResult: null }), TORRES)
      expect(chain.parents).toEqual([])
      expect(chain.opportunity.solutions[0].krChips.every((c) => c.crossOutcome)).toBe(true)
    })

    it("limits the legend to what the shape draws", () => {
      expect(buildOpportunityChain(opp(), TORRES).legend).toEqual(["objective", "keyResult", "opportunity", "solution", "assumption", "experiment"])
    })
  })

  it("derives from link emphasis, not the preset key: hiding every link yields the bare opportunity", () => {
    const chain = buildOpportunityChain(opp(), { links: { oppToKr: "hidden", oppToObjective: "hidden", solToKr: "hidden" }, tree: "outcome-rooted" })
    // Typed links are hidden, so only the legacy pointer's Objective remains as the fallback parent; no chips.
    expect(chain.parents).toHaveLength(1)
    expect(chain.opportunity.solutions[0].krChips).toEqual([])
  })

  describe("roadmap items and delivery tasks", () => {
    const withDelivery = opp({
      roadmapItems: [
        { id: "r-opp", title: "Opp level", horizon: "NOW", status: "ACTIVE", solutionId: null },
        { id: "r-sol", title: "Under solution", horizon: "NEXT", status: "ACTIVE", solutionId: "s1" },
        { id: "r-arch", title: "Archived", horizon: "LATER", status: "ARCHIVED", solutionId: null },
      ],
      deliveryTasks: Array.from({ length: CHAIN_TASK_CAP + 2 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: "TODO" })),
      solutions: [
        solution("s1", { roadmapItems: [{ id: "r-sol", title: "Under solution", horizon: "NEXT", status: "ACTIVE" }], deliveryTasks: [{ id: "st", title: "Sol task", status: "DONE" }] }),
      ],
    })

    it.each([["CLASSIC", CLASSIC], ["OPPORTUNITY_FIRST_OKR", OFO], ["TORRES_OST", TORRES]])("%s: same delivery data, no duplicates, archived dropped", (_name, m) => {
      const chain = buildOpportunityChain(withDelivery, m)
      expect(chain.opportunity.roadmapItems.map((r) => r.id)).toEqual(["r-opp"])
      expect(chain.opportunity.solutions[0].roadmapItems.map((r) => r.id)).toEqual(["r-sol"])
      expect(chain.opportunity.tasks.items).toHaveLength(CHAIN_TASK_CAP)
      expect(chain.opportunity.tasks.more).toBe(2)
      expect(chain.opportunity.solutions[0].tasks).toEqual({ items: [{ id: "st", title: "Sol task", status: "DONE" }], more: 0 })
      expect(chain.legend.slice(-2)).toEqual(["roadmapItem", "task"])
    })

    it("adds the roadmap / task legend entries only when there is something to show", () => {
      expect(buildOpportunityChain(opp(), CLASSIC).legend).not.toContain("roadmapItem")
      expect(buildOpportunityChain(opp(), CLASSIC).legend).not.toContain("task")
    })
  })

  it("passes assumptions and experiments through untouched", () => {
    const assumptions = [{ id: "a1", title: "A", riskLevel: "HIGH" as const, status: "UNTESTED" as const, experiments: [] }]
    const chain = buildOpportunityChain(opp({ solutions: [solution("s1", { assumptions })] }), CLASSIC)
    expect(chain.opportunity.solutions[0].assumptions).toBe(assumptions)
  })
})
