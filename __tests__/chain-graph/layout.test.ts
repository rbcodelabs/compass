import { describe, expect, it } from "vitest"
import { defaultTicks, groupAnchors, groupCircles, hashUnit, layoutGraph, GROUP_GAP, type LayoutNode } from "@/lib/chain-graph/layout"
import { buildChainGraph } from "@/lib/chain-graph/build"
import { groupIdOf } from "@/lib/chain-graph/cluster"
import { syntheticChainGraph } from "@/lib/chain-graph/synthetic"
import type { GroupBy } from "@/lib/chain-graph/types"
import { overviewFixture } from "./fixtures"

const toLayout = (n: number) => {
  const g = syntheticChainGraph(n)
  const nodes: LayoutNode[] = g.nodes.map((x) => ({ key: x.key, groupId: x.objectiveId ?? "none", radius: 22 }))
  const edges = g.edges.map((e) => ({ from: e.from, to: e.to }))
  return { nodes, edges }
}

describe("layoutGraph", () => {
  it("is deterministic across runs", () => {
    const { nodes, edges } = toLayout(120)
    const a = layoutGraph(nodes, edges)
    const b = layoutGraph(nodes, edges)
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it("returns finite positions for every node and handles empty input", () => {
    const { nodes, edges } = toLayout(120)
    const p = layoutGraph(nodes, edges)
    expect(p.size).toBe(nodes.length)
    for (const pt of p.values()) expect(Number.isFinite(pt.x) && Number.isFinite(pt.y)).toBe(true)
    expect(layoutGraph([], []).size).toBe(0)
  })

  it("keeps pinned nodes exactly where they were put", () => {
    const { nodes, edges } = toLayout(60)
    const pin = { x: 1234, y: -567 }
    const p = layoutGraph(nodes, edges, { pinned: new Map([[nodes[3].key, pin]]) })
    expect(p.get(nodes[3].key)).toEqual(pin)
  })

  it("honours seed positions when the tick budget is zero", () => {
    const { nodes, edges } = toLayout(30)
    const seed = new Map(nodes.map((n, i) => [n.key, { x: i * 10, y: i }]))
    const p = layoutGraph(nodes, edges, { seed, ticks: 0 })
    expect(p.get(nodes[5].key)).toEqual({ x: 50, y: 5 })
  })

  it("clusters same-group nodes closer to each other than to other groups", () => {
    const { nodes, edges } = toLayout(200)
    const p = layoutGraph(nodes, edges)
    const centroid = new Map<string, { x: number; y: number; n: number }>()
    for (const n of nodes) {
      const c = centroid.get(n.groupId) ?? { x: 0, y: 0, n: 0 }
      const pt = p.get(n.key)!
      centroid.set(n.groupId, { x: c.x + pt.x, y: c.y + pt.y, n: c.n + 1 })
    }
    const near = nodes.filter((n) => {
      const c = centroid.get(n.groupId)!
      const own = Math.hypot(p.get(n.key)!.x - c.x / c.n, p.get(n.key)!.y - c.y / c.n)
      return [...centroid.entries()].filter(([id]) => id !== n.groupId).every(([, o]) => Math.hypot(p.get(n.key)!.x - o.x / o.n, p.get(n.key)!.y - o.y / o.n) > own)
    })
    expect(near.length / nodes.length).toBeGreaterThan(0.9)
  })

  it("still separates groups at 1,000 nodes with the reduced tick budget", () => {
    const { nodes, edges } = toLayout(1000)
    const p = layoutGraph(nodes, edges)
    const centroid = new Map<string, { x: number; y: number; n: number }>()
    for (const n of nodes) {
      const c = centroid.get(n.groupId) ?? { x: 0, y: 0, n: 0 }
      const pt = p.get(n.key)!
      centroid.set(n.groupId, { x: c.x + pt.x, y: c.y + pt.y, n: c.n + 1 })
    }
    const cs = [...centroid.entries()].map(([id, c]) => [id, c.x / c.n, c.y / c.n] as const)
    const nearest = (n: LayoutNode) => {
      const pt = p.get(n.key)!
      return cs.reduce((best, c) => (Math.hypot(pt.x - c[1], pt.y - c[2]) < Math.hypot(pt.x - best[1], pt.y - best[2]) ? c : best))[0]
    }
    expect(nodes.filter((n) => nearest(n) === n.groupId).length / nodes.length).toBeGreaterThan(0.9)
  })

  it("places distinct anchors per group", () => {
    const { nodes } = toLayout(200)
    const a = groupAnchors(nodes)
    const pts = [...a.values()].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    expect(new Set(pts).size).toBe(pts.length)
  })
})

/** Layout inputs for a graph under a given grouping, exactly as the view builds them (every edge, expanded groups). */
const layoutFor = (graph: ReturnType<typeof syntheticChainGraph>, groupBy: GroupBy) => ({
  nodes: graph.nodes.map((n): LayoutNode => ({ key: n.key, groupId: groupIdOf(n, groupBy), radius: 22 })),
  edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
})
const overlappingPairs = (positions: ReadonlyMap<string, { x: number; y: number }>, nodes: readonly LayoutNode[]) => {
  const circles = groupCircles(nodes.map((n) => ({ groupId: n.groupId, ...positions.get(n.key)! })))
  const bad: string[] = []
  for (let i = 0; i < circles.length; i++)
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i]
      const b = circles[j]
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r + GROUP_GAP - 0.5) bad.push(`${a.id}/${b.id}`)
    }
  return bad
}

describe("group separation", () => {
  const graphs = {
    "synthetic 300": syntheticChainGraph(300),
    "synthetic 1000": syntheticChainGraph(1000),
    "fixture overview": buildChainGraph(overviewFixture()),
  }
  for (const [name, graph] of Object.entries(graphs)) {
    for (const groupBy of ["type", "objective", "status"] as const) {
      it(`no two group halos overlap: ${name}, grouped by ${groupBy}`, () => {
        const { nodes, edges } = layoutFor(graph, groupBy)
        const p = layoutGraph(nodes, edges)
        expect(overlappingPairs(p, nodes)).toEqual([])
      })
    }
  }

  it("Type grouping really has several groups whose edges mostly cross groups (the regression shape)", () => {
    const { nodes, edges } = layoutFor(graphs["synthetic 300"], "type")
    expect(new Set(nodes.map((n) => n.groupId)).size).toBe(6)
    const group = new Map(nodes.map((n) => [n.key, n.groupId]))
    expect(edges.filter((e) => group.get(e.from) !== group.get(e.to)).length / edges.length).toBeGreaterThan(0.9)
  })

  it("leaves a group holding a pinned node where it is, and still separates the rest", () => {
    const { nodes, edges } = layoutFor(graphs["synthetic 300"], "type")
    const base = layoutGraph(nodes, edges)
    const pinnedKey = nodes.find((n) => n.groupId === "OPPORTUNITY")!.key
    const pin = base.get(pinnedKey)!
    const again = layoutGraph(nodes, edges, { pinned: new Map([[pinnedKey, pin]]) })
    expect(again.get(pinnedKey)).toEqual(pin)
    expect(overlappingPairs(again, nodes)).toEqual([])
  })

  it("robust halo radius: one far outlier does not inflate the circle", () => {
    const tight = Array.from({ length: 20 }, (_, i) => ({ groupId: "g", x: (i % 5) * 20, y: Math.floor(i / 5) * 20 }))
    const [plain] = groupCircles(tight)
    const [withOutlier] = groupCircles([...tight, { groupId: "g", x: 2000, y: 0 }])
    expect(withOutlier.r).toBeLessThan(plain.r * 3)
    expect(withOutlier.count).toBe(21)
  })
})

describe("defaultTicks", () => {
  it("shrinks the settle budget as the graph grows", () => {
    expect(defaultTicks(100)).toBe(300)
    expect(defaultTicks(600)).toBe(200)
    expect(defaultTicks(1500)).toBe(120)
  })
})

describe("hashUnit", () => {
  it("is stable and within [0,1)", () => {
    expect(hashUnit("abc")).toBe(hashUnit("abc"))
    expect(hashUnit("abc")).not.toBe(hashUnit("abd"))
    for (const s of ["", "x", "OBJECTIVE:1"]) expect(hashUnit(s)).toBeGreaterThanOrEqual(0)
    expect(hashUnit("zzz")).toBeLessThan(1)
  })
})
