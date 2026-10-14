/**
 * Pure domain operations on a JSON Canvas, keyed by node id. The MCP `edit_canvas` tool applies a batch of
 * these server-side so an agent sends "add this card, link it to that one" instead of re-sending the whole
 * document. No I/O here: load/validate/save and concurrency live in lib/document-edit.ts.
 *
 * A batch is all-or-nothing: the first invalid op rejects the whole batch with its index, nothing is applied.
 * Operations are idempotent where that is cheap (re-adding a card or an edge that exists is a no-op), so a
 * retried batch does not duplicate content.
 */
import { randomUUID } from "node:crypto"
import { CANVAS_CARD_DEFAULT_SIZE, canvasCardKey, createCanvasCardNode, decodeCanvasCard, isCanvasCardKind, isUuid, MAX_CARD_TITLE_LENGTH, type CanvasCardKind } from "@/lib/canvas-cards"
import {
  CANVAS_ENDS,
  CANVAS_SIDES,
  isValidCanvasColor,
  type CanvasEnd,
  type CanvasSide,
  type JsonCanvas,
  type JsonCanvasEdge,
  type JsonCanvasNode,
} from "@/lib/json-canvas"

export const MAX_CANVAS_OPS = 200
const PLACEMENT_GAP = 120
const STACK_GAP = 24
const GROUP_PADDING = 40
const GROUP_LABEL_ROOM = 48
const DEFAULT_TEXT_SIZE = { width: 260, height: 120 }
const MAX_TEXT_LENGTH = 20_000
const MAX_LABEL_LENGTH = 120

type Placement = { x?: number; y?: number }
type Style = { color?: string | null }

export type CanvasOp =
  | ({ op: "add_card"; kind: CanvasCardKind; id: string; title?: string; nodeId?: string } & Placement & Style)
  | ({ op: "add_text"; text: string; nodeId?: string; width?: number; height?: number } & Placement & Style)
  | ({ op: "add_group"; label?: string; members?: string[]; nodeId?: string; width?: number; height?: number } & Placement & Style)
  | { op: "add_edge"; from: string; to: string; edgeId?: string; label?: string; fromSide?: CanvasSide; toSide?: CanvasSide; toEnd?: CanvasEnd; fromEnd?: CanvasEnd; color?: string }
  | { op: "move"; node: string; x: number; y: number }
  | { op: "update"; node?: string; edge?: string; text?: string; label?: string; title?: string; color?: string | null; width?: number; height?: number; fromSide?: CanvasSide; toSide?: CanvasSide; toEnd?: CanvasEnd; fromEnd?: CanvasEnd }
  | { op: "remove"; node?: string; edge?: string }

export type CanvasEditSummary = {
  addedNodes: number
  addedEdges: number
  removedNodes: number
  removedEdges: number
  updated: number
  moved: number
  /** Idempotent no-ops (card or edge already present). */
  skipped: number
  /** One entry per add_* op, in order: the node/edge id now in the canvas (existing id when skipped). */
  created: Array<{ index: number; op: CanvasOp["op"]; nodeId?: string; edgeId?: string; skipped?: boolean }>
}

export type CanvasEditResult = { ok: true; canvas: JsonCanvas; summary: CanvasEditSummary } | { ok: false; error: string }

class OpError extends Error {}
const bad = (message: string): never => {
  throw new OpError(message)
}

export function newCanvasNodeId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16)
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function checkColor(color: unknown): string | null | undefined {
  if (color === undefined || color === null) return color
  if (!isValidCanvasColor(color)) return bad(`color must be a preset "1"-"6" or a hex color like "#aabbcc"`)
  return color
}

function checkSize(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!isFiniteNumber(value) || value < 20 || value > 5000) return bad(`${name} must be a number between 20 and 5000`)
  return Math.round(value)
}

function runCanvasOps(input: JsonCanvas, ops: CanvasOp[], newId: () => string): CanvasEditResult {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: "ops must be a non-empty array" }
  if (ops.length > MAX_CANVAS_OPS) return { ok: false, error: `Too many ops (${ops.length}); the limit is ${MAX_CANVAS_OPS} per call` }

  // Work on copies so a rejected batch leaves the caller's canvas untouched.
  const nodes: JsonCanvasNode[] = input.nodes.map((n) => ({ ...n }))
  const edges: JsonCanvasEdge[] = input.edges.map((e) => ({ ...e }))
  const summary: CanvasEditSummary = { addedNodes: 0, addedEdges: 0, removedNodes: 0, removedEdges: 0, updated: 0, moved: 0, skipped: 0, created: [] }

  const usedIds = new Set<string>([...nodes.map((n) => n.id), ...edges.map((e) => e.id)])
  const freshId = (requested: string | undefined, what: string): string => {
    if (requested !== undefined) {
      if (typeof requested !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(requested)) return bad(`${what} must be 1-64 characters of letters, digits, "_" or "-"`)
      if (usedIds.has(requested)) return bad(`id "${requested}" is already in use`)
      usedIds.add(requested)
      return requested
    }
    let id = newId()
    while (usedIds.has(id)) id = newId()
    usedIds.add(id)
    return id
  }

  const nodeById = () => new Map(nodes.map((n) => [n.id, n]))
  const findNode = (ref: unknown, what: string): JsonCanvasNode => {
    if (typeof ref !== "string" || !ref) return bad(`${what} is required`)
    const byId = nodeById().get(ref)
    if (byId) return byId
    // Also accept a card reference "kind:uuid" so agents need not look up node ids for cards they already know.
    const match = /^([A-Za-z]+):([0-9a-fA-F-]{36})$/.exec(ref)
    if (match && isCanvasCardKind(match[1])) {
      const key = canvasCardKey({ kind: match[1], id: match[2].toLowerCase() })
      const card = nodes.find((n) => {
        const decoded = decodeCanvasCard(n)
        return decoded ? canvasCardKey(decoded) === key : false
      })
      if (card) return card
    }
    return bad(`${what} "${ref}" does not match any node id or card on the canvas`)
  }

  // Auto-placement: a column to the right of everything that was on the canvas, stacked downward in op order.
  // Nodes placed explicitly do not advance the column.
  let column: { x: number; y: number } | null = null
  const autoPlace = (height: number): { x: number; y: number } => {
    if (!column) {
      column = nodes.length
        ? { x: Math.max(...nodes.map((n) => n.x + n.width)) + PLACEMENT_GAP, y: Math.min(...nodes.map((n) => n.y)) }
        : { x: 0, y: 0 }
    }
    const at = { x: column.x, y: column.y }
    column.y += height + STACK_GAP
    return at
  }
  const place = (p: Placement, height: number): { x: number; y: number } => {
    if ((p.x === undefined) !== (p.y === undefined)) return bad("x and y must be given together (or both omitted for auto-placement)")
    if (p.x === undefined || p.y === undefined) return autoPlace(height)
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return bad("x and y must be finite numbers")
    return { x: p.x, y: p.y }
  }

  const removeNode = (node: JsonCanvasNode) => {
    nodes.splice(nodes.indexOf(node), 1)
    summary.removedNodes++
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].fromNode === node.id || edges[i].toNode === node.id) {
        edges.splice(i, 1)
        summary.removedEdges++
      }
    }
  }

  ops.forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== "object") return bad("op must be an object")
      switch (raw.op) {
        case "add_card": {
          if (!isCanvasCardKind(raw.kind)) return bad("kind is not a valid card kind")
          if (!isUuid(raw.id)) return bad("id must be a UUID")
          const ref = { kind: raw.kind, id: raw.id.toLowerCase() }
          const existing = nodes.find((n) => {
            const decoded = decodeCanvasCard(n)
            return decoded ? canvasCardKey(decoded) === canvasCardKey(ref) : false
          })
          if (existing) {
            summary.skipped++
            summary.created.push({ index, op: raw.op, nodeId: existing.id, skipped: true })
            return
          }
          if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > MAX_CARD_TITLE_LENGTH)) return bad(`title must be a string of at most ${MAX_CARD_TITLE_LENGTH} characters`)
          const color = checkColor(raw.color)
          const nodeId = freshId(raw.nodeId, "nodeId")
          const node = createCanvasCardNode(nodeId, ref, raw.title, place(raw, CANVAS_CARD_DEFAULT_SIZE.height))
          if (color) node.color = color
          nodes.push(node)
          summary.addedNodes++
          summary.created.push({ index, op: raw.op, nodeId })
          return
        }
        case "add_text": {
          if (typeof raw.text !== "string" || !raw.text) return bad("text must be a non-empty string")
          if (raw.text.length > MAX_TEXT_LENGTH) return bad(`text is too long (limit ${MAX_TEXT_LENGTH} characters)`)
          const width = checkSize(raw.width, "width") ?? DEFAULT_TEXT_SIZE.width
          const height = checkSize(raw.height, "height") ?? DEFAULT_TEXT_SIZE.height
          const color = checkColor(raw.color)
          const nodeId = freshId(raw.nodeId, "nodeId")
          const at = place(raw, height)
          nodes.push({ id: nodeId, type: "text", x: Math.round(at.x), y: Math.round(at.y), width, height, text: raw.text, ...(color ? { color } : {}) })
          summary.addedNodes++
          summary.created.push({ index, op: raw.op, nodeId })
          return
        }
        case "add_group": {
          if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > MAX_LABEL_LENGTH)) return bad(`label must be a string of at most ${MAX_LABEL_LENGTH} characters`)
          const color = checkColor(raw.color)
          const members = (raw.members ?? []).map((m, i) => findNode(m, `members[${i}]`))
          let box: { x: number; y: number; width: number; height: number }
          if (members.length) {
            const x = Math.min(...members.map((n) => n.x)) - GROUP_PADDING
            const y = Math.min(...members.map((n) => n.y)) - GROUP_PADDING - GROUP_LABEL_ROOM
            const right = Math.max(...members.map((n) => n.x + n.width)) + GROUP_PADDING
            const bottom = Math.max(...members.map((n) => n.y + n.height)) + GROUP_PADDING
            box = { x, y, width: right - x, height: bottom - y }
          } else {
            const width = checkSize(raw.width, "width") ?? 600
            const height = checkSize(raw.height, "height") ?? 400
            box = { ...place(raw, height), width, height }
          }
          const nodeId = freshId(raw.nodeId, "nodeId")
          const group: JsonCanvasNode = { id: nodeId, type: "group", x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), ...(raw.label ? { label: raw.label } : {}), ...(color ? { color } : {}) }
          // Groups sit behind the cards they surround: insert before the first member (or at the front).
          const firstMember = members.length ? Math.min(...members.map((m) => nodes.indexOf(m))) : 0
          nodes.splice(members.length ? firstMember : 0, 0, group)
          summary.addedNodes++
          summary.created.push({ index, op: raw.op, nodeId })
          return
        }
        case "add_edge": {
          const from = findNode(raw.from, "from")
          const to = findNode(raw.to, "to")
          const existing = edges.find((e) => e.fromNode === from.id && e.toNode === to.id)
          if (existing) {
            summary.skipped++
            summary.created.push({ index, op: raw.op, edgeId: existing.id, skipped: true })
            return
          }
          if (raw.fromSide !== undefined && !CANVAS_SIDES.includes(raw.fromSide)) return bad(`fromSide must be one of ${CANVAS_SIDES.join(", ")}`)
          if (raw.toSide !== undefined && !CANVAS_SIDES.includes(raw.toSide)) return bad(`toSide must be one of ${CANVAS_SIDES.join(", ")}`)
          if (raw.fromEnd !== undefined && !CANVAS_ENDS.includes(raw.fromEnd)) return bad(`fromEnd must be one of ${CANVAS_ENDS.join(", ")}`)
          if (raw.toEnd !== undefined && !CANVAS_ENDS.includes(raw.toEnd)) return bad(`toEnd must be one of ${CANVAS_ENDS.join(", ")}`)
          if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > MAX_LABEL_LENGTH)) return bad(`label must be a string of at most ${MAX_LABEL_LENGTH} characters`)
          const color = checkColor(raw.color)
          const edgeId = freshId(raw.edgeId, "edgeId")
          edges.push({
            id: edgeId,
            fromNode: from.id,
            toNode: to.id,
            ...(raw.fromSide ? { fromSide: raw.fromSide } : {}),
            ...(raw.toSide ? { toSide: raw.toSide } : {}),
            ...(raw.fromEnd ? { fromEnd: raw.fromEnd } : {}),
            ...(raw.toEnd ? { toEnd: raw.toEnd } : {}),
            ...(raw.label ? { label: raw.label } : {}),
            ...(color ? { color } : {}),
          })
          summary.addedEdges++
          summary.created.push({ index, op: raw.op, edgeId })
          return
        }
        case "move": {
          const node = findNode(raw.node, "node")
          if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return bad("x and y must be finite numbers")
          node.x = Math.round(raw.x)
          node.y = Math.round(raw.y)
          summary.moved++
          return
        }
        case "update": {
          if ((raw.node === undefined) === (raw.edge === undefined)) return bad("give exactly one of node or edge")
          if (raw.edge !== undefined) {
            const edge = edges.find((e) => e.id === raw.edge)
            if (!edge) return bad(`edge "${raw.edge}" not found`)
            if (raw.label !== undefined) {
              if (typeof raw.label !== "string" || raw.label.length > MAX_LABEL_LENGTH) return bad(`label must be a string of at most ${MAX_LABEL_LENGTH} characters`)
              if (raw.label) edge.label = raw.label
              else delete edge.label
            }
            const color = checkColor(raw.color)
            if (color === null) delete edge.color
            else if (color) edge.color = color
            for (const key of ["fromSide", "toSide"] as const) {
              if (raw[key] === undefined) continue
              if (!CANVAS_SIDES.includes(raw[key]!)) return bad(`${key} must be one of ${CANVAS_SIDES.join(", ")}`)
              edge[key] = raw[key]
            }
            for (const key of ["fromEnd", "toEnd"] as const) {
              if (raw[key] === undefined) continue
              if (!CANVAS_ENDS.includes(raw[key]!)) return bad(`${key} must be one of ${CANVAS_ENDS.join(", ")}`)
              edge[key] = raw[key]
            }
            summary.updated++
            return
          }
          const node = findNode(raw.node, "node")
          if (raw.text !== undefined) {
            if (node.type !== "text") return bad("text can only be changed on a text node")
            if (typeof raw.text !== "string" || !raw.text || raw.text.length > MAX_TEXT_LENGTH) return bad(`text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`)
            node.text = raw.text
          }
          if (raw.label !== undefined) {
            if (node.type !== "group") return bad("label can only be changed on a group")
            if (typeof raw.label !== "string" || raw.label.length > MAX_LABEL_LENGTH) return bad(`label must be a string of at most ${MAX_LABEL_LENGTH} characters`)
            if (raw.label) node.label = raw.label
            else delete node.label
          }
          if (raw.title !== undefined) {
            const card = decodeCanvasCard(node)
            if (!card) return bad("title can only be changed on a Compass card")
            if (typeof raw.title !== "string" || raw.title.length > MAX_CARD_TITLE_LENGTH) return bad(`title must be a string of at most ${MAX_CARD_TITLE_LENGTH} characters`)
            const title = raw.title.trim()
            node.compass = { kind: card.kind, id: card.id, ...(title ? { title } : {}) }
          }
          const color = checkColor(raw.color)
          if (color === null) delete node.color
          else if (color) node.color = color
          const width = checkSize(raw.width, "width")
          const height = checkSize(raw.height, "height")
          if (width !== undefined) node.width = width
          if (height !== undefined) node.height = height
          summary.updated++
          return
        }
        case "remove": {
          if ((raw.node === undefined) === (raw.edge === undefined)) return bad("give exactly one of node or edge")
          if (raw.edge !== undefined) {
            const at = edges.findIndex((e) => e.id === raw.edge)
            if (at < 0) return bad(`edge "${raw.edge}" not found`)
            edges.splice(at, 1)
            summary.removedEdges++
            return
          }
          removeNode(findNode(raw.node, "node"))
          return
        }
        default:
          return bad(`unknown op "${(raw as { op?: unknown }).op}" (expected add_card, add_text, add_group, add_edge, move, update or remove)`)
      }
    } catch (error) {
      if (error instanceof OpError) throw new OpError(`ops[${index}] (${(raw as { op?: string } | null)?.op ?? "?"}): ${error.message}`)
      throw error
    }
  })
  return { ok: true, canvas: { ...input, nodes, edges }, summary }
}

/** Apply a batch of ops. Returns a rejection (never throws) naming the first invalid op. */
export function applyCanvasOps(input: JsonCanvas, ops: CanvasOp[], newId: () => string = newCanvasNodeId): CanvasEditResult {
  try {
    return runCanvasOps(input, ops, newId)
  } catch (error) {
    if (error instanceof OpError) return { ok: false, error: error.message }
    throw error
  }
}
