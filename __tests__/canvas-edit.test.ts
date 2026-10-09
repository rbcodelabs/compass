import { describe, it, expect } from "vitest"
import { applyCanvasOps, type CanvasOp } from "@/lib/canvas-edit"
import { createCanvasCardNode } from "@/lib/canvas-cards"
import type { JsonCanvas } from "@/lib/json-canvas"

const OPP = "11111111-1111-4111-8111-111111111111"
const SOL = "22222222-2222-4222-8222-222222222222"
const OBJ = "33333333-3333-4333-8333-333333333333"

let counter = 0
const ids = () => `n${++counter}`

function base(): JsonCanvas {
  return {
    nodes: [
      createCanvasCardNode("a", { kind: "opportunity", id: OPP }, "Opp", { x: 0, y: 0 }),
      { id: "t", type: "text", x: 400, y: 100, width: 200, height: 80, text: "hello" },
    ],
    edges: [],
  }
}

function run(ops: CanvasOp[], canvas: JsonCanvas = base()) {
  counter = 0
  return applyCanvasOps(canvas, ops, ids)
}

function must(ops: CanvasOp[], canvas?: JsonCanvas) {
  const r = run(ops, canvas)
  if (!r.ok) throw new Error(r.error)
  return r
}

describe("applyCanvasOps", () => {
  it("adds a card to the right of existing content with an automatic id", () => {
    const { canvas, summary } = must([{ op: "add_card", kind: "solution", id: SOL, title: "Sol" }])
    const added = canvas.nodes[2]
    expect(added.id).toBe("n1")
    expect(added.x).toBeGreaterThan(600)
    expect(summary.addedNodes).toBe(1)
    expect(summary.created[0]).toMatchObject({ index: 0, op: "add_card", nodeId: "n1" })
  })

  it("stacks auto-placed nodes downward in op order", () => {
    const { canvas } = must([
      { op: "add_card", kind: "solution", id: SOL },
      { op: "add_text", text: "note" },
    ])
    const [card, text] = canvas.nodes.slice(2)
    expect(text.x).toBe(card.x)
    expect(text.y).toBeGreaterThan(card.y + card.height)
  })

  it("honours explicit placement and requires x and y together", () => {
    const { canvas } = must([{ op: "add_text", text: "pinned", x: 7, y: 9 }])
    expect(canvas.nodes[2]).toMatchObject({ x: 7, y: 9 })
    const r = run([{ op: "add_text", text: "bad", x: 7 }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/x and y must be given together/)
  })

  it("is idempotent for an existing card and edge", () => {
    const first = must([
      { op: "add_card", kind: "solution", id: SOL },
      { op: "add_edge", from: `opportunity:${OPP}`, to: `solution:${SOL}` },
    ])
    const second = must(
      [
        { op: "add_card", kind: "solution", id: SOL },
        { op: "add_edge", from: "a", to: "n1" },
      ],
      first.canvas
    )
    expect(second.summary.skipped).toBe(2)
    expect(second.summary.addedNodes + second.summary.addedEdges).toBe(0)
    expect(second.canvas.nodes).toHaveLength(first.canvas.nodes.length)
    expect(second.canvas.edges).toHaveLength(1)
  })

  it("resolves kind:uuid references and plain node ids", () => {
    const { canvas } = must([{ op: "add_edge", from: `opportunity:${OPP.toUpperCase()}`, to: "t", label: "why" }])
    expect(canvas.edges[0]).toMatchObject({ fromNode: "a", toNode: "t", label: "why" })
  })

  it("removing a node removes its edges", () => {
    const { canvas, summary } = must([
      { op: "add_edge", from: "a", to: "t" },
      { op: "remove", node: "t" },
    ])
    expect(canvas.nodes.map((n) => n.id)).toEqual(["a"])
    expect(canvas.edges).toEqual([])
    expect(summary).toMatchObject({ removedNodes: 1, removedEdges: 1 })
  })

  it("moves and updates nodes and edges", () => {
    const { canvas } = must([
      { op: "move", node: "t", x: 1.4, y: 2.6 },
      { op: "update", node: "t", text: "changed", color: "3", width: 300 },
      { op: "update", node: "a", title: "Renamed" },
      { op: "add_edge", from: "a", to: "t", edgeId: "e1" },
      { op: "update", edge: "e1", label: "ok", toEnd: "arrow" },
    ])
    expect(canvas.nodes.find((n) => n.id === "t")).toMatchObject({ x: 1, y: 3, text: "changed", color: "3", width: 300 })
    expect((canvas.nodes.find((n) => n.id === "a") as { compass?: { title?: string } }).compass?.title).toBe("Renamed")
    expect(canvas.edges[0]).toMatchObject({ label: "ok", toEnd: "arrow" })
  })

  it("wraps members in a group behind them", () => {
    const { canvas } = must([{ op: "add_group", label: "Cluster", members: ["a", "t"] }])
    const group = canvas.nodes[0]
    expect(group.type).toBe("group")
    for (const member of canvas.nodes.slice(1)) {
      expect(group.x).toBeLessThan(member.x)
      expect(group.y).toBeLessThan(member.y)
      expect(group.x + group.width).toBeGreaterThan(member.x + member.width)
      expect(group.y + group.height).toBeGreaterThan(member.y + member.height)
    }
  })

  it("rejects the whole batch on the first bad op and leaves the input untouched", () => {
    const input = base()
    const snapshot = JSON.stringify(input)
    counter = 0
    const r = applyCanvasOps(input, [{ op: "add_text", text: "fine" }, { op: "move", node: "missing", x: 0, y: 0 }], ids)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^ops\[1\] \(move\): node "missing"/)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it.each([
    [{ op: "add_card", kind: "nope", id: SOL }, /kind/],
    [{ op: "add_card", kind: "objective", id: "not-a-uuid" }, /UUID/],
    [{ op: "add_text", text: "" }, /text/],
    [{ op: "add_text", text: "x", color: "nine" }, /color/],
    [{ op: "add_text", text: "x", width: 5 }, /width/],
    [{ op: "add_text", text: "x", nodeId: "t" }, /already in use/],
    [{ op: "update", node: "a", edge: "e" }, /exactly one/],
    [{ op: "update", node: "a", text: "x" }, /text node/],
    [{ op: "update", node: "t", title: "x" }, /Compass card/],
    [{ op: "frobnicate" }, /unknown op/],
  ] as Array<[unknown, RegExp]>)("rejects invalid op %#", (op, message) => {
    const r = run([op as CanvasOp])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(message)
  })

  it("rejects empty and oversized batches", () => {
    expect(run([]).ok).toBe(false)
    const many = Array.from({ length: 201 }, () => ({ op: "add_text", text: "x" }) as CanvasOp)
    const r = run(many)
    expect(r.ok).toBe(false)
  })

  it("adds a card for an unseen objective", () => {
    const { canvas } = must([{ op: "add_card", kind: "objective", id: OBJ, color: "2" }])
    expect(canvas.nodes[2]).toMatchObject({ type: "link", color: "2" })
  })
})
