import { describe, expect, it } from "vitest"
import { indexGraph, traceChain } from "@/lib/chain-graph/trace"
import type { ChainEdge, ChainGraph, ChainNode } from "@/lib/chain-graph/types"

const n = (key: string): ChainNode => ({ key, type: "OPPORTUNITY", id: key, title: key, status: "X", tone: "neutral", objectiveId: null, archived: false })
const graphOf = (keys: string[], pairs: Array<[string, string]>): ChainGraph => ({
  nodes: keys.map(n),
  edges: pairs.map(([from, to]): ChainEdge => ({ id: `${from}>${to}`, from, to, kind: "primary" })),
  truncated: null,
})

describe("traceChain", () => {
  const chain = graphOf(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"]])

  it("walks upstream and downstream with hop depths", () => {
    const t = traceChain(chain, "b")!
    expect(t.upstream).toEqual([{ key: "a", depth: 1 }])
    expect(t.downstream).toEqual([{ key: "c", depth: 1 }, { key: "d", depth: 2 }])
    expect([...t.nodeKeys].sort()).toEqual(["a", "b", "c", "d"])
    expect([...t.edgeIds].sort()).toEqual(["a>b", "b>c", "c>d"])
  })

  it("honours maxDepth", () => {
    const t = traceChain(chain, "a", { maxDepth: 2 })!
    expect(t.downstream.map((d) => d.key)).toEqual(["b", "c"])
  })

  it("handles a diamond (multi-parent) without duplicates", () => {
    const g = graphOf(["root", "l", "r", "leaf"], [["root", "l"], ["root", "r"], ["l", "leaf"], ["r", "leaf"]])
    const t = traceChain(g, "leaf")!
    expect(t.upstream.map((u) => u.key).sort()).toEqual(["l", "r", "root"])
    expect(t.upstream.find((u) => u.key === "root")!.depth).toBe(2)
    expect(t.edgeIds.size).toBe(4)
  })

  it("terminates on cycles and never reports the selection as its own ancestor", () => {
    const g = graphOf(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]])
    const t = traceChain(g, "a")!
    expect(t.upstream.map((u) => u.key)).not.toContain("a")
    expect(t.downstream.map((d) => d.key)).not.toContain("a")
    expect(t.downstream.map((d) => d.key).sort()).toEqual(["b", "c"])
  })

  it("handles self-loops", () => {
    const g = graphOf(["a", "b"], [["a", "a"], ["a", "b"]])
    const t = traceChain(g, "a")!
    expect(t.downstream.map((d) => d.key)).toEqual(["b"])
    expect(t.upstream).toEqual([])
  })

  it("returns an isolated node alone, and null for an unknown key", () => {
    const g = graphOf(["a", "z"], [])
    const t = traceChain(g, "z")!
    expect(t.upstream).toEqual([])
    expect(t.downstream).toEqual([])
    expect([...t.nodeKeys]).toEqual(["z"])
    expect(traceChain(g, "missing")).toBeNull()
  })

  it("ignores edges to nodes outside the graph and accepts a prebuilt index", () => {
    const g = graphOf(["a"], [["a", "ghost"]])
    const idx = indexGraph(g)
    expect(traceChain(idx, "a")!.downstream).toEqual([])
  })
})
