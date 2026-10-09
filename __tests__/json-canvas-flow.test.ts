import { describe, it, expect } from "vitest"
import {
  createCanvasNode,
  defaultSides,
  edgeToFlow,
  fromFlow,
  newCanvasId,
  refreshAutoSides,
  toFlow,
} from "@/lib/json-canvas-flow"
import { parseJsonCanvas, type JsonCanvas } from "@/lib/json-canvas"
import { createHistory } from "@/lib/json-canvas-history"

const base: JsonCanvas = {
  metadata: { keep: true },
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "A", color: "2", ext: { n: 1 } },
    { id: "b", type: "text", x: 400, y: 0, width: 200, height: 100, text: "B" },
    { id: "g", type: "group", x: -20, y: -20, width: 700, height: 300, label: "G" },
  ],
  edges: [
    { id: "e1", fromNode: "a", toNode: "b", fromSide: "bottom", toSide: "top", toEnd: "none", fromEnd: "arrow", label: "hi", color: "#ff0000", ext: 1 },
    { id: "e2", fromNode: "a", toNode: "b" },
  ],
}

describe("toFlow / fromFlow", () => {
  it("round-trips an untouched canvas byte-for-byte, including unknown fields", () => {
    const { nodes, edges } = toFlow(base)
    expect(fromFlow(base, nodes, edges)).toEqual(base)
  })

  it("maps geometry and handles", () => {
    const { nodes, edges } = toFlow(base)
    expect(nodes[0]).toMatchObject({ id: "a", type: "text", position: { x: 0, y: 0 }, width: 200, height: 100 })
    expect(edges[0]).toMatchObject({ source: "a", target: "b", sourceHandle: "bottom", targetHandle: "top", label: "hi" })
  })

  it("derives sides for edges that omit them without writing them back", () => {
    const { nodes, edges } = toFlow(base)
    expect(edges[1].sourceHandle).toBe("right")
    expect(edges[1].targetHandle).toBe("left")
    const out = fromFlow(base, nodes, edges)
    expect(out.edges[1].fromSide).toBeUndefined()
    expect(out.edges[1].toSide).toBeUndefined()
  })

  it("applies the spec default: toEnd=arrow, fromEnd=none", () => {
    const { edges } = toFlow(base)
    expect(edges[1].markerEnd).toBeTruthy()
    expect(edges[1].markerStart).toBeUndefined()
    // explicit overrides invert it for e1
    expect(edges[0].markerEnd).toBeUndefined()
    expect(edges[0].markerStart).toBeTruthy()
  })

  it("writes back moved/resized nodes as integers", () => {
    const { nodes, edges } = toFlow(base)
    const moved = nodes.map((n) => (n.id === "a" ? { ...n, position: { x: 10.6, y: -3.2 }, width: 301.4, height: 120.5 } : n))
    const out = fromFlow(base, moved, edges)
    expect(out.nodes[0]).toMatchObject({ x: 11, y: -3, width: 301, height: 121, text: "A", color: "2", ext: { n: 1 } })
  })

  it("drops deleted nodes and the edges that touched them, keeps order, appends new nodes", () => {
    const { nodes, edges } = toFlow(base)
    const fresh = createCanvasNode("link", { x: 5, y: 6 })
    const nextNodes = [...nodes.filter((n) => n.id !== "b"), ...toFlow({ nodes: [fresh], edges: [] }).nodes]
    const out = fromFlow(base, nextNodes, edges)
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "g", fresh.id])
    expect(out.edges).toEqual([])
  })

  it("explicit connections persist their sides; auto ones stay implicit", () => {
    const { nodes } = toFlow(base)
    const connection = edgeToFlow({ id: "e9", fromNode: "a", toNode: "b", fromSide: "left", toSide: "right" }, nodes)
    const out = fromFlow(base, nodes, [connection])
    expect(out.edges[0]).toMatchObject({ id: "e9", fromSide: "left", toSide: "right" })
  })

  it("keeps edge label and color edits", () => {
    const { nodes, edges } = toFlow(base)
    const edited = edges.map((e) => (e.id === "e2" ? edgeToFlow({ ...e.data.raw, label: "new", color: "4" }, nodes) : e))
    const out = fromFlow(base, nodes, edited)
    expect(out.edges[1]).toMatchObject({ label: "new", color: "4" })
  })

  it("the mapped result always re-validates", () => {
    const { nodes, edges } = toFlow(base)
    expect(parseJsonCanvas(JSON.stringify(fromFlow(base, nodes, edges))).ok).toBe(true)
  })
})

describe("defaultSides / refreshAutoSides", () => {
  const box = (x: number, y: number) => ({ x, y, width: 100, height: 100 })
  it("picks facing sides from relative position", () => {
    expect(defaultSides(box(0, 0), box(300, 0))).toEqual({ fromSide: "right", toSide: "left" })
    expect(defaultSides(box(300, 0), box(0, 0))).toEqual({ fromSide: "left", toSide: "right" })
    expect(defaultSides(box(0, 0), box(0, 300))).toEqual({ fromSide: "bottom", toSide: "top" })
    expect(defaultSides(box(0, 300), box(0, 0))).toEqual({ fromSide: "top", toSide: "bottom" })
  })

  it("re-derives auto sides after a node moves but leaves explicit sides alone", () => {
    const { nodes, edges } = toFlow(base)
    const moved = nodes.map((n) => (n.id === "b" ? { ...n, position: { x: 0, y: 500 } } : n))
    const refreshed = refreshAutoSides(moved, edges)
    expect(refreshed[1].sourceHandle).toBe("bottom")
    expect(refreshed[1].targetHandle).toBe("top")
    expect(refreshed[0].sourceHandle).toBe("bottom")
    expect(refreshed[0].targetHandle).toBe("top")
  })
})

describe("createCanvasNode / newCanvasId", () => {
  it("creates valid nodes of each type with unique ids", () => {
    const nodes = (["text", "link", "group", "file"] as const).map((type) => createCanvasNode(type, { x: 1, y: 2 }))
    expect(new Set(nodes.map((n) => n.id)).size).toBe(4)
    expect(parseJsonCanvas(JSON.stringify({ nodes, edges: [] })).ok).toBe(true)
    expect(newCanvasId()).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("createHistory", () => {
  it("supports undo/redo and truncates the redo branch on a new push", () => {
    const h = createHistory<number>(0)
    h.push(1)
    h.push(2)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.undo()).toBeUndefined()
    expect(h.canUndo()).toBe(false)
    expect(h.redo()).toBe(1)
    h.push(9)
    expect(h.canRedo()).toBe(false)
    expect(h.undo()).toBe(1)
  })

  it("ignores pushes equal to the current state and caps depth", () => {
    const h = createHistory<string>("a", { limit: 3 })
    h.push("a")
    expect(h.canUndo()).toBe(false)
    for (const s of ["b", "c", "d", "e"]) h.push(s)
    const seen: string[] = []
    let v = h.undo()
    while (v !== undefined) { seen.push(v); v = h.undo() }
    expect(seen).toEqual(["d", "c"])
  })
})

describe("group drag", () => {
  const canvas: JsonCanvas = {
    nodes: [
      { id: "g", type: "group", x: 0, y: 0, width: 500, height: 300, label: "G" },
      { id: "in", type: "text", x: 20, y: 20, width: 100, height: 50, text: "in" },
      { id: "nested", type: "group", x: 150, y: 20, width: 200, height: 200, label: "N" },
      { id: "deep", type: "text", x: 160, y: 30, width: 50, height: 50, text: "deep" },
      { id: "straddle", type: "text", x: 450, y: 20, width: 100, height: 50, text: "s" },
      { id: "out", type: "text", x: 900, y: 0, width: 100, height: 50, text: "out" },
    ],
    edges: [],
  }

  it("treats fully-contained nodes (including nested groups) as members", async () => {
    const { groupMemberIds } = await import("@/lib/json-canvas-flow")
    const { nodes } = toFlow(canvas)
    expect(groupMemberIds(nodes, "g").sort()).toEqual(["deep", "in", "nested"])
  })

  it("moves members by the group's displacement, once", async () => {
    const { snapshotGroupDrag, applyGroupDrag } = await import("@/lib/json-canvas-flow")
    const { nodes } = toFlow(canvas)
    const snap = snapshotGroupDrag(nodes, ["g"])
    const moved = nodes.map((n) => (n.id === "g" ? { ...n, position: { x: 100, y: 40 } } : n))
    const next = applyGroupDrag(moved, snap, ["g"])
    const pos = (id: string) => next.find((n) => n.id === id)!.position
    expect(pos("in")).toEqual({ x: 120, y: 60 })
    expect(pos("deep")).toEqual({ x: 260, y: 70 })
    expect(pos("straddle")).toEqual({ x: 450, y: 20 })
    expect(pos("out")).toEqual({ x: 900, y: 0 })
    // Idempotent against the same snapshot (no cumulative drift).
    expect(applyGroupDrag(next, snap, ["g"]).find((n) => n.id === "in")!.position).toEqual({ x: 120, y: 60 })
  })

  it("skips members React Flow is already dragging", async () => {
    const { snapshotGroupDrag, applyGroupDrag } = await import("@/lib/json-canvas-flow")
    const { nodes } = toFlow(canvas)
    const snap = snapshotGroupDrag(nodes, ["g", "in"])
    const moved = nodes.map((n) => (n.id === "g" || n.id === "in" ? { ...n, position: { x: n.position.x + 10, y: n.position.y } } : n))
    const next = applyGroupDrag(moved, snap, ["g", "in"])
    expect(next.find((n) => n.id === "in")!.position).toEqual({ x: 30, y: 20 })
  })
})
