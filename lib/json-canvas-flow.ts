/**
 * Mapping layer between JSON Canvas documents and React Flow's node/edge model.
 *
 * The original canvas node/edge object rides along in `data.raw`, so every
 * field the editor does not model (including unknown ones from other apps)
 * survives a load -> edit -> save cycle. Geometry is the only thing read back
 * from the flow state; everything else is edited by replacing `data.raw`.
 *
 * Kept free of @xyflow imports so it stays unit-testable and the structural
 * types below are assignable to React Flow's Node/Edge.
 */
import {
  resolveCanvasColor,
  type CanvasNodeType,
  type CanvasSide,
  type JsonCanvas,
  type JsonCanvasEdge,
  type JsonCanvasNode,
} from "@/lib/json-canvas"

export type FlowNode = {
  id: string
  type: CanvasNodeType
  position: { x: number; y: number }
  width: number
  height: number
  zIndex: number
  data: { raw: JsonCanvasNode }
  selected?: boolean
}

export type FlowEdge = {
  id: string
  source: string
  target: string
  sourceHandle: CanvasSide
  targetHandle: CanvasSide
  label?: string
  markerEnd?: { type: "arrowclosed"; color?: string }
  markerStart?: { type: "arrowclosed"; color?: string }
  style?: { stroke: string }
  data: { raw: JsonCanvasEdge; autoFrom: boolean; autoTo: boolean }
  selected?: boolean
}

type Box = { x: number; y: number; width: number; height: number }

export const NODE_DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  file: { width: 260, height: 90 },
  link: { width: 260, height: 90 },
  group: { width: 480, height: 320 },
}

export function newCanvasId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

export function createCanvasNode(type: CanvasNodeType, at: { x: number; y: number }): JsonCanvasNode {
  const size = NODE_DEFAULT_SIZE[type]
  const node: JsonCanvasNode = { id: newCanvasId(), type, x: Math.round(at.x), y: Math.round(at.y), ...size }
  if (type === "text") node.text = ""
  if (type === "link") node.url = "https://"
  if (type === "file") node.file = "untitled.md"
  if (type === "group") node.label = "Group"
  return node
}

/** Pick the facing sides of two boxes from their relative centers. */
export function defaultSides(from: Box, to: Box): { fromSide: CanvasSide; toSide: CanvasSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" }
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" }
}

function boxOf(node: FlowNode): Box {
  return { x: node.position.x, y: node.position.y, width: node.width, height: node.height }
}

export function nodeToFlow(raw: JsonCanvasNode): FlowNode {
  return {
    id: raw.id,
    type: raw.type,
    position: { x: raw.x, y: raw.y },
    width: raw.width,
    height: raw.height,
    // Groups are purely spatial in JSON Canvas; keep them behind the cards they surround.
    zIndex: raw.type === "group" ? 0 : 1,
    data: { raw },
  }
}

export function edgeToFlow(raw: JsonCanvasEdge, nodes: FlowNode[]): FlowEdge {
  const from = nodes.find((n) => n.id === raw.fromNode)
  const to = nodes.find((n) => n.id === raw.toNode)
  const auto = from && to ? defaultSides(boxOf(from), boxOf(to)) : { fromSide: "right" as const, toSide: "left" as const }
  const color = resolveCanvasColor(raw.color)
  // Spec defaults: fromEnd "none", toEnd "arrow".
  const marker = { type: "arrowclosed" as const, ...(color ? { color } : {}) }
  return {
    id: raw.id,
    source: raw.fromNode,
    target: raw.toNode,
    sourceHandle: raw.fromSide ?? auto.fromSide,
    targetHandle: raw.toSide ?? auto.toSide,
    ...(raw.label ? { label: raw.label } : {}),
    ...((raw.toEnd ?? "arrow") === "arrow" ? { markerEnd: marker } : {}),
    ...(raw.fromEnd === "arrow" ? { markerStart: marker } : {}),
    ...(color ? { style: { stroke: color } } : {}),
    data: { raw, autoFrom: raw.fromSide === undefined, autoTo: raw.toSide === undefined },
  }
}

export function toFlow(canvas: JsonCanvas): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = canvas.nodes.map(nodeToFlow)
  return { nodes, edges: canvas.edges.map((edge) => edgeToFlow(edge, nodes)) }
}

/** Recompute handles for edges whose sides were never chosen explicitly (after nodes move/resize). */
export function refreshAutoSides(nodes: FlowNode[], edges: FlowEdge[]): FlowEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return edges.map((edge) => {
    if (!edge.data.autoFrom && !edge.data.autoTo) return edge
    const from = byId.get(edge.source)
    const to = byId.get(edge.target)
    if (!from || !to) return edge
    const auto = defaultSides(boxOf(from), boxOf(to))
    return {
      ...edge,
      sourceHandle: edge.data.autoFrom ? auto.fromSide : edge.sourceHandle,
      targetHandle: edge.data.autoTo ? auto.toSide : edge.targetHandle,
    }
  })
}

/**
 * Write flow state back into a canvas. `base` supplies top-level unknown
 * fields (e.g. `metadata`); node/edge order is the flow array order, so z-order
 * is preserved and new items append.
 */
export function fromFlow(base: JsonCanvas, nodes: FlowNode[], edges: FlowEdge[]): JsonCanvas {
  const ids = new Set(nodes.map((node) => node.id))
  const outNodes = nodes.map<JsonCanvasNode>((node) => ({
    ...node.data.raw,
    id: node.id,
    x: Math.round(node.position.x),
    y: Math.round(node.position.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
  }))
  const outEdges = edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map<JsonCanvasEdge>((edge) => ({
      ...edge.data.raw,
      id: edge.id,
      fromNode: edge.source,
      toNode: edge.target,
      ...(edge.data.autoFrom ? {} : { fromSide: edge.sourceHandle }),
      ...(edge.data.autoTo ? {} : { toSide: edge.targetHandle }),
    }))
  return { ...base, nodes: outNodes, edges: outEdges }
}
