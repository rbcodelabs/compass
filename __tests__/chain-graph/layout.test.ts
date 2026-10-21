import { describe, expect, it } from "vitest"
import { groupAnchors, hashUnit, layoutGraph, type LayoutNode } from "@/lib/chain-graph/layout"
import { syntheticChainGraph } from "@/lib/chain-graph/synthetic"

const toLayout = (n: number) => {
  const g = syntheticChainGraph(n)
  const nodes: LayoutNode[] = g.nodes.map((x) => ({ key: x.key, groupId: x.objectiveId ?? "none", radius: 14 }))
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

  it("places distinct anchors per group", () => {
    const { nodes } = toLayout(200)
    const a = groupAnchors(nodes)
    const pts = [...a.values()].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    expect(new Set(pts).size).toBe(pts.length)
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
