import { describe, expect, it } from "vitest"
import { canvasCardKey } from "@/lib/canvas-cards"
import { layoutTreeCards } from "@/lib/canvas-tree-layout"
import type { TreeCard, TreeEdge } from "@/lib/canvas-tree"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

describe("layoutTreeCards", () => {
  it("lays a parent to the left of its child and keeps siblings apart, ignoring typed links", async () => {
    const cards: TreeCard[] = [
      { ref: { kind: "objective", id: id(1) }, title: "O" },
      { ref: { kind: "keyResult", id: id(2) }, title: "K" },
      { ref: { kind: "opportunity", id: id(3) }, title: "A" },
      { ref: { kind: "opportunity", id: id(4) }, title: "B" },
    ]
    const k = cards.map((c) => canvasCardKey(c.ref))
    const edges: TreeEdge[] = [
      { from: k[0], to: k[1], secondary: false, link: false },
      { from: k[1], to: k[2], secondary: false, link: false },
      { from: k[1], to: k[3], secondary: false, link: false },
      { from: k[2], to: k[0], secondary: true, link: true },
    ]
    const positions = await layoutTreeCards(cards, edges)
    expect(positions.size).toBe(4)
    expect(positions.get(k[0])!.x).toBeLessThan(positions.get(k[1])!.x)
    expect(positions.get(k[1])!.x).toBeLessThan(positions.get(k[2])!.x)
    expect(Math.abs(positions.get(k[2])!.y - positions.get(k[3])!.y)).toBeGreaterThanOrEqual(120)
  })
})
