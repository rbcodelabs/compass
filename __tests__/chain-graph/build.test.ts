import { describe, expect, it } from "vitest"
import { buildChainGraph } from "@/lib/chain-graph/build"
import { overviewFixture } from "./fixtures"

const edgeSet = (g: ReturnType<typeof buildChainGraph>) => g.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort()

describe("buildChainGraph", () => {
  it("maps every core type to a node with tone, group and archived flag; keeps Key Results out", () => {
    const g = buildChainGraph(overviewFixture())
    expect(g.nodes.map((n) => n.type)).not.toContain("KEY_RESULT")
    const byKey = new Map(g.nodes.map((n) => [n.key, n]))
    expect(byKey.get("OBJECTIVE:o2")).toMatchObject({ tone: "warning", objectiveId: "o2", archived: false })
    expect(byKey.get("OPPORTUNITY:p2")).toMatchObject({ archived: true, tone: "neutral" })
    expect(byKey.get("EXPERIMENT:e2")).toMatchObject({ archived: true })
    expect(byKey.get("ASSUMPTION:a1")).toMatchObject({ tone: "warning", objectiveId: "o2" }) // inherits the nearer (link) objective of s1
    expect(byKey.get("ROADMAP_ITEM:r1")).toMatchObject({ status: "NOW", tone: "info" })
  })

  it("contracts Key Results into their Objective", () => {
    const g = buildChainGraph(overviewFixture())
    expect(edgeSet(g)).toContain("OBJECTIVE:o1>OPPORTUNITY:p1:primary")
    expect(edgeSet(g)).toContain("OBJECTIVE:o2>OPPORTUNITY:p2:primary")
    // the Objective -> KR edge becomes a self loop and is dropped
    expect(g.edges.every((e) => e.from !== e.to)).toBe(true)
  })

  it("builds FK chain edges and marks the second roadmap parent as secondary", () => {
    const e = edgeSet(buildChainGraph(overviewFixture()))
    expect(e).toContain("OPPORTUNITY:p1>SOLUTION:s1:primary")
    expect(e).toContain("SOLUTION:s1>ASSUMPTION:a1:primary")
    expect(e).toContain("ASSUMPTION:a1>EXPERIMENT:e1:primary")
    expect(e).toContain("SOLUTION:s1>ROADMAP_ITEM:r1:primary")
    expect(e).toContain("OPPORTUNITY:p1>ROADMAP_ITEM:r1:secondary")
  })

  it("orients the typed Solution->KR link parent->child (Objective -> Solution) so downstream stays downstream", () => {
    const e = edgeSet(buildChainGraph(overviewFixture()))
    expect(e).toContain("OBJECTIVE:o2>SOLUTION:s1:link")
    expect(e.some((x) => x.startsWith("SOLUTION:s1>OBJECTIVE"))).toBe(false)
  })

  it("keeps the nearest-upstream objective as the group (deterministic with two upstream objectives)", () => {
    const g = buildChainGraph(overviewFixture())
    // s1 has parents o1 (via p1) at depth 2 and o2 (link) at depth 1 -> nearest wins
    expect(g.nodes.find((n) => n.key === "SOLUTION:s1")!.objectiveId).toBe("o2")
  })

  it("leaves nodes with no upstream objective ungrouped", () => {
    const g = buildChainGraph(overviewFixture())
    expect(g.nodes.find((n) => n.key === "EXPERIMENT:e2")!.objectiveId).toBeNull()
  })

  it("drops a duplicate edge and keeps the strongest kind", () => {
    const o = overviewFixture()
    // p1 is already primary child of o1 through k1; a LEGACY-free DIRECT link o1 -> p1 adds a link duplicate
    o.links = { opportunityObjective: [{ opportunityId: "p1", objectiveId: "o1", origin: "DIRECT" }], solutionKeyResult: [] } as never
    const g = buildChainGraph(o, { edgeOptions: { links: { oppToObjective: "secondary" } } })
    const matches = g.edges.filter((e) => e.id === "OBJECTIVE:o1>OPPORTUNITY:p1")
    expect(matches).toHaveLength(1)
    expect(matches[0].kind).toBe("primary")
  })

  it("drops edges whose endpoint is unknown (dangling FK / foreign workspace row)", () => {
    const o = overviewFixture()
    o.solutions.push({ id: "s9", opportunityId: "foreign-opp", title: "Orphan", status: "IDEA", position: null } as never)
    const g = buildChainGraph(o)
    expect(g.nodes.some((n) => n.id === "s9")).toBe(true)
    expect(g.edges.some((e) => e.to === "SOLUTION:s9")).toBe(false)
  })

  it("is deterministic", () => {
    expect(buildChainGraph(overviewFixture())).toEqual(buildChainGraph(overviewFixture()))
  })

  describe("caps", () => {
    it("reports nothing when under the caps", () => {
      expect(buildChainGraph(overviewFixture()).truncated).toBeNull()
    })

    it("applies the per-type cap, archived last, and reports shown/total", () => {
      const g = buildChainGraph(overviewFixture(), { perTypeCap: 1 })
      expect(g.nodes.filter((n) => n.type === "OPPORTUNITY").map((n) => n.id)).toEqual(["p1"]) // p2 is archived: cut first
      expect(g.truncated?.byType.OPPORTUNITY).toEqual({ shown: 1, total: 2 })
      expect(g.truncated?.total).toBe(9)
    })

    it("applies the global cap in chain order and drops edges to cut nodes", () => {
      const g = buildChainGraph(overviewFixture(), { globalCap: 3 })
      expect(g.nodes).toHaveLength(3)
      expect(g.nodes.map((n) => n.type)).toEqual(["OBJECTIVE", "OBJECTIVE", "OPPORTUNITY"])
      const keys = new Set(g.nodes.map((n) => n.key))
      expect(g.edges.every((e) => keys.has(e.from) && keys.has(e.to))).toBe(true)
      expect(g.truncated).toMatchObject({ shown: 3 })
    })
  })
})
