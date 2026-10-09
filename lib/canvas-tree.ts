/**
 * Automatic OST tree build-out for JSON Canvas docs.
 *
 * Turns the workspace's Opportunity Solution Tree (Objective -> Key Result ->
 * Opportunity -> Solution -> Assumption -> Experiment, plus Roadmap items) into
 * ordinary canvas content: Compass link cards (lib/canvas-cards.ts), edges and
 * one group per Objective. Nothing here is special to the editor afterwards --
 * the user drags, regroups and deletes the result like any other canvas content.
 *
 * Pure module: no DB, no React, no layout engine. The server builds a
 * `TreeFragment` from the already-fetched overview (buildTreeFragment), the
 * client lays the new cards out (lib/canvas-tree-layout.ts) and merges them into
 * the open canvas (mergeTreeIntoCanvas).
 *
 * Merge rules (idempotent, non-destructive):
 *  - a Compass object already on the canvas is never duplicated, moved or regrouped;
 *  - an edge is added only when at least one end is a newly added card, so an
 *    edge the user deliberately deleted does not come back on the next build;
 *  - new content is placed to the right of everything already on the canvas.
 */
import { buildCanvasEdges, type CanvasEdgeOptions } from "@/lib/canvas/edges"
import type { CanvasOverview } from "@/lib/canvas/data"
import {
  CANVAS_CARD_DEFAULT_SIZE,
  canvasCardKey,
  createCanvasCardNode,
  decodeCanvasCard,
  isCanvasCardRef,
  type CanvasCardKind,
  type CanvasCardRef,
} from "@/lib/canvas-cards"
import { MAX_CANVAS_BYTES, type JsonCanvas, type JsonCanvasEdge, type JsonCanvasNode } from "@/lib/json-canvas"

/** Hard cap on cards added by one build; keeps the canvas well under MAX_CANVAS_BYTES and the editor responsive. */
export const MAX_TREE_CARDS = 400

export const TREE_SCOPE_KINDS = ["objective", "keyResult", "opportunity", "solution"] as const
export type TreeScopeKind = (typeof TREE_SCOPE_KINDS)[number]
export type TreeScope = { kind: "workspace" } | { kind: TreeScopeKind; id: string }

export type TreeCard = { ref: CanvasCardRef; title: string }
export type TreeEdge = {
  from: string
  to: string
  /** Not the primary parent (extra roadmap parents, typed links). Drawn, but colored differently. */
  secondary: boolean
  /** Typed-link edge: drawn but never fed to the layout (it can close a cycle). */
  link: boolean
}
export type TreeGroup = { key: string; title: string; members: string[] }
export type TreeFragment = { cards: TreeCard[]; edges: TreeEdge[]; groups: TreeGroup[]; truncated: boolean }

const GROUP_PADDING = 40
const GROUP_LABEL_ROOM = 48
const PLACEMENT_GAP = 120
const SECONDARY_EDGE_COLOR = "6"

type Entry = { kind: CanvasCardKind; id: string; title: string }

function entriesOf(overview: CanvasOverview): Entry[] {
  return [
    ...overview.objectives.map((r) => ({ kind: "objective" as const, id: r.id, title: r.title })),
    ...overview.keyResults.map((r) => ({ kind: "keyResult" as const, id: r.id, title: r.title })),
    ...overview.opportunities.map((r) => ({ kind: "opportunity" as const, id: r.id, title: r.title })),
    ...overview.solutions.map((r) => ({ kind: "solution" as const, id: r.id, title: r.title })),
    ...overview.assumptions.map((r) => ({ kind: "assumption" as const, id: r.id, title: r.title })),
    ...overview.experiments.map((r) => ({ kind: "experiment" as const, id: r.id, title: r.title })),
    ...overview.roadmapItems.map((r) => ({ kind: "roadmapItem" as const, id: r.id, title: r.title })),
  ]
}

/**
 * Select the part of the tree to draw and shape it as cards + edges + groups.
 * Ids in the overview are globally unique UUIDs, so an entity id alone keys an edge endpoint.
 */
export function buildTreeFragment(
  overview: CanvasOverview,
  options: { scope: TreeScope; edgeOptions?: CanvasEdgeOptions; maxCards?: number }
): TreeFragment {
  const maxCards = options.maxCards ?? MAX_TREE_CARDS
  const entries = new Map<string, Entry>()
  for (const entry of entriesOf(overview)) if (isCanvasCardRef(entry)) entries.set(entry.id, entry)

  const allEdges = buildCanvasEdges(overview, options.edgeOptions)
  const primary = allEdges.filter((e) => !e.dashed && !e.link)
  const children = new Map<string, string[]>()
  for (const edge of primary) {
    const list = children.get(edge.source) ?? []
    list.push(edge.target)
    children.set(edge.source, list)
  }

  // Breadth-first so a parent always precedes its children: truncation can never strand a child without its parent.
  const order: string[] = []
  const seen = new Set<string>()
  const walk = (roots: string[]) => {
    const queue = roots.filter((id) => entries.has(id) && !seen.has(id))
    queue.forEach((id) => seen.add(id))
    for (let i = 0; i < queue.length; i++) {
      order.push(queue[i])
      for (const child of children.get(queue[i]) ?? []) {
        if (seen.has(child) || !entries.has(child)) continue
        seen.add(child)
        queue.push(child)
      }
    }
  }

  // An objective nested under a key result is drawn beneath its parent, not as a root of its own.
  const nestedObjectives = new Set(overview.objectives.filter((o) => o.parentKeyResultId && entries.has(o.parentKeyResultId)).map((o) => o.id))
  const scope = options.scope
  if (scope.kind === "workspace") {
    walk(overview.objectives.filter((o) => !nestedObjectives.has(o.id)).map((o) => o.id))
    // Anything not under an objective (orphan opportunities, solutions, ...) still belongs in a full build-out.
    walk([...entries.keys()].filter((id) => !seen.has(id)))
  } else {
    walk([scope.id])
  }

  const truncated = order.length > maxCards
  const kept = order.slice(0, maxCards)
  const keptSet = new Set(kept)

  const cards: TreeCard[] = kept.map((id) => {
    const entry = entries.get(id)!
    return { ref: { kind: entry.kind, id: entry.id }, title: entry.title }
  })
  const keyOf = (id: string) => canvasCardKey({ kind: entries.get(id)!.kind, id })

  const edges: TreeEdge[] = allEdges
    .filter((e) => keptSet.has(e.source) && keptSet.has(e.target))
    .map((e) => ({ from: keyOf(e.source), to: keyOf(e.target), secondary: Boolean(e.dashed || e.link), link: Boolean(e.link) }))

  // One group per root objective: each card goes to the first objective that reaches it through primary edges.
  const groups: TreeGroup[] = []
  const claimed = new Set<string>()
  const objectiveRoots = overview.objectives.filter((o) => keptSet.has(o.id) && !nestedObjectives.has(o.id))
  for (const objective of objectiveRoots) {
    const members: string[] = []
    const queue = [objective.id]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      if (claimed.has(id)) continue
      claimed.add(id)
      members.push(keyOf(id))
      for (const child of children.get(id) ?? []) if (keptSet.has(child)) queue.push(child)
    }
    if (members.length >= 2) groups.push({ key: keyOf(objective.id), title: objective.title, members })
  }

  return { cards, edges, groups, truncated }
}

export type Point = { x: number; y: number }

export type MergeResult =
  | { ok: true; canvas: JsonCanvas; addedCards: number; addedEdges: number; addedGroups: number; skippedCards: number }
  | { ok: false; reason: "too-large" }

/**
 * Merge a built fragment into the current canvas. `positions` (keyed by canvasCardKey, relative to an arbitrary
 * origin) comes from the layout step; cards without a position fall back to a simple column so a layout failure
 * still produces a usable canvas. `newId` supplies node/edge ids (injected so tests are deterministic).
 */
export function mergeTreeIntoCanvas(
  canvas: JsonCanvas,
  fragment: TreeFragment,
  positions: ReadonlyMap<string, Point>,
  newId: () => string
): MergeResult {
  const existingNodeByKey = new Map<string, string>()
  for (const node of canvas.nodes) {
    const card = decodeCanvasCard(node)
    if (card) existingNodeByKey.set(canvasCardKey(card), node.id)
  }

  const fresh = fragment.cards.filter((c) => !existingNodeByKey.has(canvasCardKey(c.ref)))
  const skippedCards = fragment.cards.length - fresh.length
  if (fresh.length === 0) return { ok: true, canvas, addedCards: 0, addedEdges: 0, addedGroups: 0, skippedCards }

  // Normalise the layout to its own top-left, then anchor it to the right of whatever is already on the canvas.
  const rel = new Map<string, Point>()
  fresh.forEach((card, index) => {
    const key = canvasCardKey(card.ref)
    rel.set(key, positions.get(key) ?? { x: 0, y: index * (CANVAS_CARD_DEFAULT_SIZE.height + 24) })
  })
  const minX = Math.min(...[...rel.values()].map((p) => p.x))
  const minY = Math.min(...[...rel.values()].map((p) => p.y))
  const anchor = canvas.nodes.length
    ? { x: Math.max(...canvas.nodes.map((n) => n.x + n.width)) + PLACEMENT_GAP, y: Math.min(...canvas.nodes.map((n) => n.y)) }
    : { x: 0, y: 0 }

  const nodeIdByKey = new Map(existingNodeByKey)
  const cardNodes: JsonCanvasNode[] = fresh.map((card) => {
    const key = canvasCardKey(card.ref)
    const at = rel.get(key)!
    const node = createCanvasCardNode(newId(), card.ref, card.title, { x: anchor.x + at.x - minX, y: anchor.y + at.y - minY })
    nodeIdByKey.set(key, node.id)
    return node
  })
  const freshKeys = new Set(fresh.map((c) => canvasCardKey(c.ref)))

  const existingEdgePairs = new Set(canvas.edges.map((e) => `${e.fromNode}>${e.toNode}`))
  const edges: JsonCanvasEdge[] = []
  for (const edge of fragment.edges) {
    if (!freshKeys.has(edge.from) && !freshKeys.has(edge.to)) continue
    const fromNode = nodeIdByKey.get(edge.from)
    const toNode = nodeIdByKey.get(edge.to)
    if (!fromNode || !toNode || existingEdgePairs.has(`${fromNode}>${toNode}`)) continue
    existingEdgePairs.add(`${fromNode}>${toNode}`)
    edges.push({ id: newId(), fromNode, toNode, ...(edge.secondary ? { color: SECONDARY_EDGE_COLOR } : {}) })
  }

  // Groups only for objectives drawn in this build, around their newly added members.
  const groupNodes: JsonCanvasNode[] = []
  const byId = new Map(cardNodes.map((n) => [n.id, n]))
  for (const group of fragment.groups) {
    if (!freshKeys.has(group.key)) continue
    const members = group.members.filter((k) => freshKeys.has(k)).map((k) => byId.get(nodeIdByKey.get(k)!)!).filter(Boolean)
    if (members.length < 2) continue
    const x = Math.min(...members.map((n) => n.x)) - GROUP_PADDING
    const y = Math.min(...members.map((n) => n.y)) - GROUP_PADDING - GROUP_LABEL_ROOM
    const right = Math.max(...members.map((n) => n.x + n.width)) + GROUP_PADDING
    const bottom = Math.max(...members.map((n) => n.y + n.height)) + GROUP_PADDING
    groupNodes.push({ id: newId(), type: "group", x, y, width: right - x, height: bottom - y, label: group.title.slice(0, 120) })
  }

  const merged: JsonCanvas = {
    ...canvas,
    // Groups first so they sit behind the cards they surround.
    nodes: [...canvas.nodes, ...groupNodes, ...cardNodes],
    edges: [...canvas.edges, ...edges],
  }
  if (JSON.stringify(merged).length > MAX_CANVAS_BYTES) return { ok: false, reason: "too-large" }
  return { ok: true, canvas: merged, addedCards: cardNodes.length, addedEdges: edges.length, addedGroups: groupNodes.length, skippedCards }
}
