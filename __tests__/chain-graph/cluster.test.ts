import { describe, expect, it } from "vitest"
import { buildChainGraph } from "@/lib/chain-graph/build"
import { clusterKey, defaultCollapsed, listGroups, projectGraph } from "@/lib/chain-graph/cluster"
import { syntheticChainGraph } from "@/lib/chain-graph/synthetic"
import { overviewFixture } from "./fixtures"

const graph = buildChainGraph(overviewFixture())
const none = new Set<string>()

describe("projectGraph", () => {
  it("hides archived nodes by default and shows them on request; edges to hidden nodes vanish", () => {
    const hidden = projectGraph(graph, { groupBy: "objective", collapsed: none })
    expect(hidden.nodes.map((v) => v.key)).not.toContain("OPPORTUNITY:p2")
    expect(hidden.edges.some((e) => e.to === "OPPORTUNITY:p2")).toBe(false)
    const shown = projectGraph(graph, { groupBy: "objective", collapsed: none, showArchived: true })
    expect(shown.nodes.map((v) => v.key)).toContain("OPPORTUNITY:p2")
    expect(shown.edges.some((e) => e.to === "OPPORTUNITY:p2")).toBe(true)
  })

  it("filters hidden types without bridging across them", () => {
    const p = projectGraph(graph, { groupBy: "type", collapsed: none, hiddenTypes: new Set(["SOLUTION"]) })
    expect(p.nodes.some((v) => v.kind === "node" && v.node.type === "SOLUTION")).toBe(false)
    expect(p.edges.some((e) => e.from === "OPPORTUNITY:p1" && e.to === "ASSUMPTION:a1")).toBe(false)
  })

  it("collapses a group into one cluster node with counts, and aggregates edges with weights", () => {
    const sync = syntheticChainGraph(60)
    const first = sync.nodes[0].id
    const collapsedKey = clusterKey("objective", first)
    const p = projectGraph(sync, { groupBy: "objective", collapsed: new Set([first]) })
    const cluster = p.nodes.find((v) => v.kind === "cluster")!
    expect(cluster.key).toBe(collapsedKey)
    expect(cluster.kind === "cluster" && cluster.count).toBe(sync.nodes.filter((x) => x.objectiveId === first).length)
    expect(p.nodes.filter((v) => v.kind === "node" && v.groupId === first)).toHaveLength(0)
    expect(p.edges.every((e) => e.from !== e.to)).toBe(true)
  })

  it("aggregates multiple member edges between two clusters into one weighted edge", () => {
    const g = buildChainGraph(overviewFixture())
    const p = projectGraph(g, { groupBy: "type", collapsed: new Set(["OPPORTUNITY", "SOLUTION"]) })
    const e = p.edges.filter((x) => x.from === clusterKey("type", "OPPORTUNITY") && x.to === clusterKey("type", "SOLUTION"))
    expect(e).toHaveLength(1)
    expect(e[0].weight).toBe(1)
    const rm = p.edges.filter((x) => x.to === "ROADMAP_ITEM:r1")
    expect(rm.map((x) => x.from).sort()).toEqual([clusterKey("type", "OPPORTUNITY"), clusterKey("type", "SOLUTION")])
  })

  it("sums weights when several member edges collapse onto the same pair", () => {
    const sync = syntheticChainGraph(60)
    const p = projectGraph(sync, { groupBy: "type", collapsed: new Set(["ASSUMPTION", "EXPERIMENT"]) })
    const e = p.edges.find((x) => x.from === clusterKey("type", "ASSUMPTION") && x.to === clusterKey("type", "EXPERIMENT"))!
    expect(e.weight).toBe(sync.nodes.filter((n) => n.type === "EXPERIMENT").length)
  })

  it("flags the cluster that contains the selection and maps members to their representative", () => {
    // a1 hangs under s1, whose nearest objective is o2 (typed link)
    const p = projectGraph(graph, { groupBy: "objective", collapsed: new Set(["o2"]), selection: "ASSUMPTION:a1" })
    const cluster = p.nodes.find((v) => v.kind === "cluster")!
    expect(cluster.kind === "cluster" && cluster.containsSelection).toBe(true)
    expect(p.representative.get("ASSUMPTION:a1")).toBe(clusterKey("objective", "o2"))
    expect(p.representative.get("OPPORTUNITY:p1")).toBe("OPPORTUNITY:p1")
    const other = projectGraph(graph, { groupBy: "objective", collapsed: new Set(["o2"]), selection: "OPPORTUNITY:p1" })
    expect(other.nodes.find((v) => v.kind === "cluster" && v.containsSelection)).toBeUndefined()
  })

  it("supports group-by status", () => {
    const p = projectGraph(graph, { groupBy: "status", collapsed: new Set(["UNTESTED"]) })
    expect(p.groups.find((g) => g.id === "UNTESTED")).toMatchObject({ collapsed: true, count: 1 })
    expect(p.nodes.find((v) => v.key === clusterKey("status", "UNTESTED"))).toBeDefined()
  })

  it("gives groups a stable index independent of filters", () => {
    const all = listGroups(graph, "objective")
    const filtered = projectGraph(graph, { groupBy: "objective", collapsed: none, hiddenTypes: new Set(["OBJECTIVE"]) })
    for (const g of filtered.groups) expect(g.index).toBe(all.find((x) => x.id === g.id)!.index)
  })

  it("never lets a collapsed group's hidden members leak edges", () => {
    const p = projectGraph(graph, { groupBy: "objective", collapsed: new Set(["o1", "o2"]) })
    expect(p.nodes.every((v) => v.kind === "cluster")).toBe(true)
  })
})

describe("defaultCollapsed", () => {
  it("is empty at or below the threshold and all groups above it", () => {
    expect(defaultCollapsed(graph, "objective", 300).size).toBe(0)
    const big = syntheticChainGraph(400)
    const c = defaultCollapsed(big, "objective", 300)
    expect(c.size).toBe(listGroups(big, "objective").length)
  })
})
