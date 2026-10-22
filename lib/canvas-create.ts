/**
 * Inline creation of Compass objects from a JSON canvas (pure rules; no DB, no React).
 *
 * Only kinds that can be created from a title alone (plus, for two of them, the card the person had selected as parent)
 * are offered. Experiments are left out: they require a hypothesis, a method and a kill condition, which a quick-create
 * form cannot honestly collect. The canvas stores only the reference; the server action in docs/actions.ts creates the record.
 */
import { MAX_CARD_TITLE_LENGTH, type CanvasCardKind } from "@/lib/canvas-cards"
import type { JsonCanvasEdge } from "@/lib/json-canvas"

export const CANVAS_CREATE_KINDS = ["opportunity", "solution", "task", "assumption"] as const
export type CanvasCreateKind = (typeof CANVAS_CREATE_KINDS)[number]

/** Kinds that cannot exist without a parent, and the kind that parent must be. */
export const CANVAS_CREATE_PARENT_KIND: Partial<Record<CanvasCreateKind, CanvasCardKind>> = {
  solution: "opportunity",
  assumption: "solution",
}

export function isCanvasCreateKind(value: unknown): value is CanvasCreateKind {
  return typeof value === "string" && (CANVAS_CREATE_KINDS as readonly string[]).includes(value)
}

/** Kinds offered given the kind of the selected card (undefined: nothing, or a non-Compass card, is selected). */
export function creatableKinds(selectedKind: CanvasCardKind | undefined): CanvasCreateKind[] {
  return CANVAS_CREATE_KINDS.filter((kind) => {
    const required = CANVAS_CREATE_PARENT_KIND[kind]
    return !required || required === selectedKind
  })
}

/** The selected card is only a parent for kinds that nest under it (a task created from an opportunity gets no edge). */
export function parentFor(kind: CanvasCreateKind, selectedKind: CanvasCardKind | undefined): boolean {
  const required = CANVAS_CREATE_PARENT_KIND[kind]
  return required !== undefined && required === selectedKind
}

export type TitleResult = { ok: true; title: string } | { ok: false; error: string }

export function normalizeCreateTitle(raw: unknown): TitleResult {
  if (typeof raw !== "string") return { ok: false, error: "Title is required." }
  const title = raw.trim()
  if (!title) return { ok: false, error: "Title is required." }
  if (title.length > MAX_CARD_TITLE_LENGTH) return { ok: false, error: `Title must be ${MAX_CARD_TITLE_LENGTH} characters or fewer.` }
  return { ok: true, title }
}

/** Parent -> child edge, matching the direction of the derived OST edges. Sides are left to the editor's auto-sides. */
export function parentEdge(id: string, parentNodeId: string, childNodeId: string): JsonCanvasEdge {
  return { id, fromNode: parentNodeId, toNode: childNodeId }
}

/** Center for a new child: directly below its parent, with a gap for the edge. */
export function childCenterBelow(
  parent: { x: number; y: number; width: number; height: number },
  child: { width: number; height: number },
  gap = 80
): { x: number; y: number } {
  return { x: parent.x + parent.width / 2, y: parent.y + parent.height + gap + child.height / 2 }
}
