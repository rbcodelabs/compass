import { describe, expect, it } from "vitest"
import { buildChainGraph } from "@/lib/chain-graph/build"
import { chainFocusParam, clampDepth, DEFAULT_FOCUS_DEPTH, focusSubgraph, MAX_FOCUS_DEPTH, parseFocusRef, resolveFocusKey } from "@/lib/chain-graph/focus"
import { syntheticChainGraph } from "@/lib/chain-graph/synthetic"
import { overviewFixture } from "./fixtures"

describe("parseFocusRef", () => {
  it("accepts TYPE:uuid, TYPE:display-id and a bare display id; rejects the rest", () => {
    expect(parseFocusRef("OPPORTUNITY:abc-123")).toEqual({ type: "OPPORTUNITY", ref: "abc-123" })
    expect(parseFocusRef("SOLUTION:SOL-4")).toEqual({ type: "SOLUTION", ref: "SOL-4" })
    expect(parseFocusRef("OPP-12")).toEqual({ type: null, ref: "OPP-12" })
    expect(parseFocusRef(["SOLUTION:x1", "ignored"])).toEqual({ type: "SOLUTION", ref: "x1" })
    expect(parseFocusRef("TASK:abc")).toBeNull()
    expect(parseFocusRef("OPPORTUNITY:")).toBeNull()
    expect(parseFocusRef("OPPORTUNITY:a b")).toBeNull()
    expect(parseFocusRef("TASK-5")).toBeNull()
    expect(parseFocusRef("not an id")).toBeNull()
    expect(parseFocusRef(undefined)).toBeNull()
  })
})

describe("chainFocusParam", () => {
  it("maps core-chain panel types and nothing else", () => {
    expect(chainFocusParam("objective", "o1")).toBe("OBJECTIVE:o1")
    expect(chainFocusParam("roadmapItem", "OPP-1")).toBe("ROADMAP_ITEM:OPP-1")
    expect(chainFocusParam("keyResult", "k1")).toBeNull()
    expect(chainFocusParam("task", "t1")).toBeNull()
    expect(chainFocusParam("opportunity-new", "x")).toBeNull()
  })
})

describe("clampDepth", () => {
  it("defaults, clamps to 1..12 and ignores junk", () => {
    expect(clampDepth(null)).toBe(DEFAULT_FOCUS_DEPTH)
    expect(clampDepth("abc")).toBe(DEFAULT_FOCUS_DEPTH)
    expect(clampDepth("0")).toBe(1)
    expect(clampDepth("99")).toBe(MAX_FOCUS_DEPTH)
    expect(clampDepth("3")).toBe(3)
  })
})

describe("focusSubgraph", () => {
  const graph = buildChainGraph(overviewFixture())

  it("returns the chain around the focus with only edges between kept nodes", () => {
    const sub = focusSubgraph(graph, "ASSUMPTION:a1")!
    const keys = new Set(sub.nodes.map((n) => n.key))
    expect(keys.has("ASSUMPTION:a1") && keys.has("EXPERIMENT:e1") && keys.has("SOLUTION:s1")).toBe(true)
    expect(keys.has("EXPERIMENT:e2")).toBe(false) // unrelated
    for (const e of sub.edges) expect(keys.has(e.from) && keys.has(e.to)).toBe(true)
    expect(sub.truncated).toBeNull()
  })

  it("honours depth", () => {
    const sub = focusSubgraph(graph, "OBJECTIVE:o1", 1)!
    expect(sub.nodes.map((n) => n.key).sort()).toEqual(["OBJECTIVE:o1", "OPPORTUNITY:p1"])
  })

  it("caps, nearest first, and reports the cut", () => {
    const big = syntheticChainGraph(300)
    const sub = focusSubgraph(big, big.nodes[0].key, 12, 20)!
    expect(sub.nodes).toHaveLength(20)
    expect(sub.truncated).toMatchObject({ shown: 20 })
    expect(sub.truncated!.total).toBeGreaterThan(20)
    expect(sub.nodes.some((n) => n.key === big.nodes[0].key)).toBe(true)
  })

  it("is null for an unknown key", () => {
    expect(focusSubgraph(graph, "SOLUTION:nope")).toBeNull()
  })
})

describe("resolveFocusKey", () => {
  const row = (id: string, seqPrefix: string, seqNumber: number) => ({ id, seqPrefix, seqNumber })
  const fake = (rows: Array<{ id: string; seqPrefix: string; seqNumber: number }>) => ({
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => (where.id ? r.id === where.id : r.seqPrefix === where.seqPrefix && r.seqNumber === where.seqNumber)) ?? null,
  })
  const U = "11111111-1111-4111-8111-111111111111"
  const db = { opportunity: fake([row(U, "OPP", 12)]), solution: fake([]) }

  it("resolves typed and bare display ids to a node key, and a UUID", async () => {
    expect(await resolveFocusKey(db, "ws", { type: "OPPORTUNITY", ref: "OPP-12" })).toBe(`OPPORTUNITY:${U}`)
    expect(await resolveFocusKey(db, "ws", { type: null, ref: "OPP-12" })).toBe(`OPPORTUNITY:${U}`)
    expect(await resolveFocusKey(db, "ws", { type: "OPPORTUNITY", ref: U })).toBe(`OPPORTUNITY:${U}`)
  })

  it("is null for unknown ids, wrong-type display ids and types outside the core chain", async () => {
    expect(await resolveFocusKey(db, "ws", { type: "OPPORTUNITY", ref: "OPP-99" })).toBeNull()
    expect(await resolveFocusKey(db, "ws", { type: "SOLUTION", ref: "OPP-12" })).toBeNull()
  })
})
