/**
 * Compass object cards on a JSON Canvas.
 *
 * JSON Canvas 1.0 has no custom node types, so a Compass card is encoded as a
 * STANDARD `link` node:
 *   { type: "link", url: "compass://<kind>/<id>", compass: { kind, id, title? } }
 * Other tools (Obsidian, Geode) show a plain link card and keep the unknown
 * `compass` field; Compass renders a live card. The canvas stores only the
 * reference (+ a cached title for degraded display) -- never object data.
 *
 * Pure module: no DB, no React. Anything read from canvas content is untrusted;
 * the server re-authorizes every reference when rendering
 * (lib/canvas-card-data.ts).
 */
import type { JsonCanvas, JsonCanvasNode } from "@/lib/json-canvas"

export const CANVAS_CARD_KINDS = [
  "opportunity",
  "solution",
  "metric",
  "doc",
  "task",
  "experiment",
  "objective",
  "keyResult",
  "assumption",
  "roadmapItem",
] as const
export type CanvasCardKind = (typeof CANVAS_CARD_KINDS)[number]

export type CanvasCardRef = { kind: CanvasCardKind; id: string }
export type DecodedCanvasCard = CanvasCardRef & { title?: string }

export const CANVAS_CARD_KIND_LABELS: Record<CanvasCardKind, string> = {
  opportunity: "Opportunity",
  solution: "Solution",
  metric: "Metric",
  doc: "Doc",
  task: "Task",
  experiment: "Experiment",
  objective: "Objective",
  keyResult: "Key result",
  assumption: "Assumption",
  roadmapItem: "Roadmap item",
}

/** dataTransfer type for dragging a Compass object (JSON {kind,id,title}) onto a canvas. */
export const CANVAS_CARD_DRAG_TYPE = "application/x-compass-card"

export const CANVAS_CARD_DEFAULT_SIZE = { width: 280, height: 120 }
export const MAX_CARD_TITLE_LENGTH = 255
/** Upper bound on references resolved per request. */
export const MAX_CARD_REFS = 100

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URL_PATTERN = /^compass:\/\/([A-Za-z]+)\/([0-9a-fA-F-]{36})$/

export function isCanvasCardKind(value: unknown): value is CanvasCardKind {
  return typeof value === "string" && (CANVAS_CARD_KINDS as readonly string[]).includes(value)
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

export function isCanvasCardRef(value: unknown): value is CanvasCardRef {
  return typeof value === "object" && value !== null && isCanvasCardKind((value as CanvasCardRef).kind) && isUuid((value as CanvasCardRef).id)
}

export const canvasCardKey = (ref: CanvasCardRef) => `${ref.kind}:${ref.id}`

export function canvasCardUrl(ref: CanvasCardRef): string {
  return `compass://${ref.kind}/${ref.id}`
}

export function parseCanvasCardUrl(url: unknown): CanvasCardRef | null {
  if (typeof url !== "string") return null
  const match = URL_PATTERN.exec(url)
  if (!match) return null
  const ref = { kind: match[1], id: match[2] }
  return isCanvasCardRef(ref) ? ref : null
}

export function encodeCanvasCardFields(ref: CanvasCardRef, title?: string) {
  const cleaned = title?.trim().slice(0, MAX_CARD_TITLE_LENGTH)
  return { url: canvasCardUrl(ref), compass: { kind: ref.kind, id: ref.id, ...(cleaned ? { title: cleaned } : {}) } }
}

export function createCanvasCardNode(
  nodeId: string,
  ref: CanvasCardRef,
  title: string | undefined,
  at: { x: number; y: number }
): JsonCanvasNode {
  return {
    id: nodeId,
    type: "link",
    x: Math.round(at.x),
    y: Math.round(at.y),
    ...CANVAS_CARD_DEFAULT_SIZE,
    ...encodeCanvasCardFields(ref, title),
  }
}

/** The Compass reference a node carries, or null for any ordinary node. */
export function decodeCanvasCard(node: JsonCanvasNode): DecodedCanvasCard | null {
  if (node.type !== "link") return null
  const field = node.compass
  if (field && typeof field === "object" && !Array.isArray(field) && isCanvasCardRef(field)) {
    const title = (field as { title?: unknown }).title
    return { kind: field.kind, id: field.id, ...(typeof title === "string" && title ? { title } : {}) }
  }
  // Another tool may have stripped the unknown field; the url still names the object.
  return parseCanvasCardUrl(node.url)
}

/**
 * Check every `compass` field. strict (MCP): invalid references are errors.
 * lenient (UI saves, imported files): invalid references are dropped so the
 * node degrades to the plain link card it already is.
 */
export function sanitizeCanvasCards(canvas: JsonCanvas, options: { strict: boolean }): { canvas: JsonCanvas; errors: string[] } {
  const errors: string[] = []
  const nodes = canvas.nodes.map((node, index) => {
    if (!("compass" in node)) return node
    const where = `nodes[${index}].compass`
    const field = node.compass
    let problem: string | null = null
    if (node.type !== "link") problem = `${where} is only allowed on link nodes`
    else if (!field || typeof field !== "object" || Array.isArray(field)) problem = `${where} must be an object like {"kind","id"}`
    else if (!isCanvasCardKind((field as { kind?: unknown }).kind)) problem = `${where}.kind must be one of ${CANVAS_CARD_KINDS.join(", ")}`
    else if (!isUuid((field as { id?: unknown }).id)) problem = `${where}.id must be a UUID`
    else if ((field as { title?: unknown }).title !== undefined && typeof (field as { title?: unknown }).title !== "string") problem = `${where}.title must be a string`
    if (problem) {
      if (options.strict) errors.push(problem)
      const { compass: _dropped, ...rest } = node
      void _dropped
      return rest as JsonCanvasNode
    }
    const title = (field as { title?: string }).title
    if (title !== undefined && title.length > MAX_CARD_TITLE_LENGTH) {
      return { ...node, compass: { ...(field as object), title: title.slice(0, MAX_CARD_TITLE_LENGTH) } }
    }
    return node
  })
  return { canvas: { ...canvas, nodes }, errors }
}
