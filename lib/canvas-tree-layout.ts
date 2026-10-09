/**
 * Layered (ELK) layout for a tree fragment's cards. Kept apart from lib/canvas-tree.ts so that module stays
 * engine-free and unit-testable; this one is only called from the canvas editor (client side).
 */
import { computeCanvasLayout, type CanvasNodeType } from "@/lib/canvas/layout"
import { CANVAS_CARD_DEFAULT_SIZE, canvasCardKey } from "@/lib/canvas-cards"
import type { Point, TreeCard, TreeEdge } from "@/lib/canvas-tree"

export async function layoutTreeCards(cards: TreeCard[], edges: TreeEdge[]): Promise<Map<string, Point>> {
  const keys = new Set(cards.map((c) => canvasCardKey(c.ref)))
  const laidOut = await computeCanvasLayout(
    cards.map((c) => ({ id: canvasCardKey(c.ref), type: c.ref.kind as CanvasNodeType, position: null })),
    // Typed-link edges can close a cycle (Solution -> Key Result) and would reshuffle the tree, so they never shape the layout.
    edges
      .filter((e) => !e.link && keys.has(e.from) && keys.has(e.to))
      .map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to })),
    () => CANVAS_CARD_DEFAULT_SIZE
  )
  return new Map(laidOut.map((n) => [n.id, { x: n.x, y: n.y }]))
}
