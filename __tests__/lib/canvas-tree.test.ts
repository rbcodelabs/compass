import { describe, expect, it } from "vitest"
import type { CanvasOverview } from "@/lib/canvas/data"
import { canvasCardKey, decodeCanvasCard } from "@/lib/canvas-cards"
import { buildTreeFragment, mergeTreeIntoCanvas, type Point, type TreeFragment } from "@/lib/canvas-tree"
import { parseJsonCanvas, type JsonCanvas } from "@/lib/json-canvas"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const [O1, O2, KR1, KR2, OPP1, OPP2, SOL1, ASM1, EXP1, RM1, OPP_ORPHAN] = Array.from({ length: 11 }, (_, i) => id(i + 1))

function overview(over: Partial<CanvasOverview> = {}): CanvasOverview {
  return {
    objectives: [
      { id: O1, title: "Grow", status: "ON_TRACK", squad: null, position: null },
      { id: O2, title: "Retain", status: "ON_TRACK", squad: null, position: null },
    ],
    keyResults: [
      { id: KR1, objectiveId: O1, title: "KR one", current: 0, target: 1, unit: null, position: null },
      { id: KR2, objectiveId: O2, title: "KR two", current: 0, target: 1, unit: null, position: null },
    ],
    opportunities: [
      { id: OPP1, title: "Opp one", status: "EXPLORING", squad: null, linkedKeyResultId: KR1, position: null },
      { id: OPP2, title: "Opp two", status: "EXPLORING", squad: null, linkedKeyResultId: KR2, position: null },
      { id: OPP_ORPHAN, title: "Orphan opp", status: "EXPLORING", squad: null, linkedKeyResultId: null, position: null },
    ],
    solutions: [{ id: SOL1, opportunityId: OPP1, title: "Sol", status: "PROPOSED", position: null }],
    assumptions: [{ id: ASM1, solutionId: SOL1, title: "Asm", riskLevel: "HIGH", status: "UNTESTED", position: null }],
    experiments: [{ id: EXP1, assumptionId: ASM1, title: "Exp", squad: null, status: "PLANNED", conclusion: null, position: null }],
    roadmapItems: [
      // Primary parent is the solution; the opportunity is a dashed secondary parent.
      { id: RM1, title: "Ship", horizon: "NOW", squad: null, solutionId: SOL1, keyResultId: null, opportunityId: OPP1, experimentId: null, isBug: false, position: null },
    ],
    ...over,
  } as CanvasOverview
}

const key = (kind: Parameters<typeof canvasCardKey>[0]["kind"], i: string) => canvasCardKey({ kind, id: i })
const empty: JsonCanvas = { nodes: [], edges: [] }
let counter = 0
const nextId = () => `n${++counter}`
const noPositions = new Map<string, Point>()

describe("buildTreeFragment", () => {
  it("builds the whole workspace: every entity, one group per root objective, orphans included", () => {
    const f = buildTreeFragment(overview(), { scope: { kind: "workspace" } })
    expect(f.cards).toHaveLength(11)
    expect(f.cards.map((c) => c.ref.id)).toContain(OPP_ORPHAN)
    expect(f.truncated).toBe(false)
    expect(f.groups).toHaveLength(2)
  })

  it("groups each objective with its subtree and never shares a card between groups", () => {
    const f = buildTreeFragment(overview(), { scope: { kind: "workspace" } })
    expect(f.groups.map((g) => g.title)).toEqual(["Grow", "Retain"])
    const grow = f.groups[0].members
    expect(grow).toEqual(expect.arrayContaining([key("objective", O1), key("keyResult", KR1), key("opportunity", OPP1), key("solution", SOL1), key("assumption", ASM1), key("experiment", EXP1), key("roadmapItem", RM1)]))
    expect(f.groups[1].members.sort()).toEqual([key("objective", O2), key("keyResult", KR2), key("opportunity", OPP2)].sort())
    const all = f.groups.flatMap((g) => g.members)
    expect(new Set(all).size).toBe(all.length)
  })

  it("scopes to descendants of the chosen root only", () => {
    const f = buildTreeFragment(overview(), { scope: { kind: "opportunity", id: OPP1 } })
    expect(f.cards.map((c) => c.ref.kind).sort()).toEqual(["assumption", "experiment", "opportunity", "roadmapItem", "solution"])
    expect(f.cards.find((c) => c.ref.id === KR1)).toBeUndefined()
    expect(f.groups).toEqual([]) // no objective in scope
  })

  it("returns nothing for an unknown scope id", () => {
    expect(buildTreeFragment(overview(), { scope: { kind: "objective", id: id(99) } }).cards).toEqual([])
  })

  it("marks extra roadmap parents as secondary", () => {
    const f = buildTreeFragment(overview(), { scope: { kind: "workspace" } })
    const primary = f.edges.find((e) => e.from === key("solution", SOL1) && e.to === key("roadmapItem", RM1))
    const secondary = f.edges.find((e) => e.from === key("opportunity", OPP1) && e.to === key("roadmapItem", RM1))
    expect(primary).toMatchObject({ secondary: false, link: false })
    expect(secondary).toMatchObject({ secondary: true })
  })

  it("truncates in parent-first order so no card is stranded, and drops edges to cut cards", () => {
    const f = buildTreeFragment(overview(), { scope: { kind: "workspace" }, maxCards: 4 })
    expect(f.truncated).toBe(true)
    expect(f.cards).toHaveLength(4)
    const keys = new Set(f.cards.map((c) => canvasCardKey(c.ref)))
    for (const e of f.edges) expect(keys.has(e.from) && keys.has(e.to)).toBe(true)
  })
})

describe("mergeTreeIntoCanvas", () => {
  const fragment = (): TreeFragment => buildTreeFragment(overview(), { scope: { kind: "workspace" } })

  it("adds compass link cards, edges and groups to an empty canvas, and the result is a valid canvas", () => {
    const r = mergeTreeIntoCanvas(empty, fragment(), noPositions, nextId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.addedCards).toBe(11)
    expect(r.addedGroups).toBe(2)
    expect(r.canvas.nodes.filter((n) => n.type === "link").every((n) => decodeCanvasCard(n) !== null)).toBe(true)
    expect(parseJsonCanvas(JSON.stringify(r.canvas)).ok).toBe(true)
    const ids = r.canvas.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of r.canvas.edges) expect(ids).toContain(e.fromNode)
  })

  it("is idempotent: building again adds nothing and leaves the canvas untouched", () => {
    const first = mergeTreeIntoCanvas(empty, fragment(), noPositions, nextId)
    if (!first.ok) throw new Error("expected ok")
    const second = mergeTreeIntoCanvas(first.canvas, fragment(), noPositions, nextId)
    expect(second).toMatchObject({ ok: true, addedCards: 0, addedEdges: 0, addedGroups: 0, skippedCards: 11 })
    if (second.ok) expect(second.canvas).toBe(first.canvas)
  })

  it("keeps the user's layout and deleted edges, and only wires new cards into existing ones", () => {
    const partial = buildTreeFragment(overview(), { scope: { kind: "objective", id: O1 } })
    const first = mergeTreeIntoCanvas(empty, partial, noPositions, nextId)
    if (!first.ok) throw new Error("expected ok")
    // The user drags a card and deletes an edge.
    const moved = first.canvas.nodes.map((n) => (decodeCanvasCard(n)?.id === KR1 ? { ...n, x: 5000, y: 5000 } : n))
    const edgesWithoutOne = first.canvas.edges.slice(1)
    const edited: JsonCanvas = { ...first.canvas, nodes: moved, edges: edgesWithoutOne }

    const second = mergeTreeIntoCanvas(edited, fragment(), noPositions, nextId)
    if (!second.ok) throw new Error("expected ok")
    expect(second.skippedCards).toBe(7)
    expect(second.canvas.nodes.find((n) => decodeCanvasCard(n)?.id === KR1)).toMatchObject({ x: 5000, y: 5000 })
    // The deleted edge joins two pre-existing cards, so it is not resurrected.
    expect(second.canvas.edges.filter((e) => !edgesWithoutOne.includes(e) && !first.canvas.edges.includes(e)).length).toBe(second.addedEdges)
    const removed = first.canvas.edges[0]
    expect(second.canvas.edges.some((e) => e.fromNode === removed.fromNode && e.toNode === removed.toNode)).toBe(false)
  })

  it("places new content to the right of existing content, never on top of it", () => {
    const base: JsonCanvas = { nodes: [{ id: "t", type: "text", x: 100, y: 50, width: 200, height: 100, text: "note" }], edges: [] }
    const r = mergeTreeIntoCanvas(base, fragment(), noPositions, nextId)
    if (!r.ok) throw new Error("expected ok")
    for (const n of r.canvas.nodes.filter((n) => n.id !== "t" && n.type === "link")) expect(n.x).toBeGreaterThanOrEqual(300 + 100)
  })

  it("uses layout positions, normalised to a shared origin", () => {
    const f = buildTreeFragment(overview(), { scope: { kind: "opportunity", id: OPP_ORPHAN } })
    const positions = new Map([[key("opportunity", OPP_ORPHAN), { x: 777, y: 333 }]])
    const r = mergeTreeIntoCanvas(empty, f, positions, nextId)
    if (!r.ok) throw new Error("expected ok")
    expect(r.canvas.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })

  it("surrounds a new objective's cards with a labelled group and skips single-card groups", () => {
    const r = mergeTreeIntoCanvas(empty, fragment(), noPositions, nextId)
    if (!r.ok) throw new Error("expected ok")
    const group = r.canvas.nodes.find((n) => n.type === "group" && n.label === "Grow")!
    const members = r.canvas.nodes.filter((n) => n.type === "link" && ["objective", "keyResult", "opportunity", "solution", "assumption", "experiment", "roadmapItem"].includes(decodeCanvasCard(n)!.kind))
    const inside = members.filter((n) => n.x >= group.x && n.y >= group.y && n.x + n.width <= group.x + group.width && n.y + n.height <= group.y + group.height)
    expect(inside.length).toBeGreaterThanOrEqual(7)

    const single = buildTreeFragment(overview(), { scope: { kind: "objective", id: O1 }, maxCards: 1 })
    const one = mergeTreeIntoCanvas(empty, single, noPositions, nextId)
    if (one.ok) expect(one.addedGroups).toBe(0)
  })

  it("refuses to grow a canvas past the size limit", () => {
    const big: JsonCanvas = { nodes: [{ id: "t", type: "text", x: 0, y: 0, width: 10, height: 10, text: "x".repeat(800_000) }], edges: [] }
    expect(mergeTreeIntoCanvas(big, fragment(), noPositions, nextId)).toEqual({ ok: false, reason: "too-large" })
  })

  it("preserves unknown top-level canvas fields", () => {
    const base = { nodes: [], edges: [], metadata: { app: "obsidian" } } as unknown as JsonCanvas
    const r = mergeTreeIntoCanvas(base, fragment(), noPositions, nextId)
    if (!r.ok) throw new Error("expected ok")
    expect((r.canvas as unknown as { metadata: unknown }).metadata).toEqual({ app: "obsidian" })
  })
})
