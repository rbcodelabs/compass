/**
 * Pure builder: CanvasOverview -> ChainGraph. No Prisma, no React.
 *
 * The overview already comes from the read-flag-aware loaders (getCanvasOverview reads Opportunity<->Objective and
 * Solution<->Key Result links through readByFamilyMode, so a flipped family is served from entity_links with no change
 * here), and buildCanvasEdges already encodes the thinking-model rules and cycle avoidance. This module only reshapes:
 *
 *  - Key Results are contracted into their Objective (KR -> Opportunity becomes Objective -> Opportunity), because v1
 *    shows the core chain only. Self-loops and duplicates produced by the contraction are dropped, strongest kind wins.
 *  - Every edge is oriented parent -> child by chain rank. The typed Solution -> Key Result link points "up" the chain
 *    in the canvas; oriented here it becomes Objective -> Solution, so downstream always means further along the chain
 *    and a trace from a Solution does not swallow the Objective's whole subtree.
 *  - Caps are applied per type then globally, in chain order, archived rows last; edges to a cut node are dropped (a
 *    dangling edge would misdraw the chain). Truncation is reported.
 */
import { buildCanvasEdges, type CanvasEdgeOptions } from "@/lib/canvas/edges"
import type { CanvasOverview } from "@/lib/canvas/data"
import {
  CHAIN_NODE_TYPES,
  chainRank,
  nodeKey,
  type ChainEdge,
  type ChainEdgeKind,
  type ChainGraph,
  type ChainNode,
  type ChainNodeType,
  type StatusTone,
  type TruncationInfo,
} from "./types"

export const DEFAULT_GLOBAL_CAP = 1500
export const DEFAULT_PER_TYPE_CAP = 600

export type BuildChainGraphOptions = {
  /** Thinking-model emphasis, the same object the canvas builder takes. */
  edgeOptions?: CanvasEdgeOptions
  globalCap?: number
  perTypeCap?: number
}

const OBJECTIVE_TONE: Record<string, StatusTone> = { ON_TRACK: "info", AT_RISK: "warning", OFF_TRACK: "danger", COMPLETE: "success" }
const OPPORTUNITY_TONE: Record<string, StatusTone> = { EXPLORING: "neutral", VALIDATING: "info", PRIORITIZED: "info", ACTIVE: "success", ARCHIVED: "neutral" }
const SOLUTION_TONE: Record<string, StatusTone> = { IDEA: "neutral", VALIDATED: "success", IN_DELIVERY: "info", SHIPPED: "success", KILLED: "neutral" }
const ASSUMPTION_TONE: Record<string, StatusTone> = { UNTESTED: "warning", TESTING: "info", VALIDATED: "success", INVALIDATED: "danger" }
const EXPERIMENT_TONE: Record<string, StatusTone> = { DESIGNING: "neutral", RUNNING: "info", COMPLETE: "success", KILLED: "neutral", NOT_PURSUED: "neutral" }
const HORIZON_TONE: Record<string, StatusTone> = { NOW: "info", NEXT: "neutral", LATER: "neutral", LAUNCHING: "info", LAUNCHED: "success", SHIPPED: "success" }

const ARCHIVED_OPPORTUNITY = new Set(["ARCHIVED"])
const ARCHIVED_SOLUTION = new Set(["KILLED"])
const ARCHIVED_EXPERIMENT = new Set(["KILLED", "NOT_PURSUED"])

const KIND_STRENGTH: Record<ChainEdgeKind, number> = { primary: 3, secondary: 2, link: 1 }

function toneOf(table: Record<string, StatusTone>, status: string): StatusTone {
  return table[status] ?? "neutral"
}

function candidateNodes(overview: CanvasOverview): ChainNode[] {
  const make = (type: ChainNodeType, id: string, title: string, status: string, tone: StatusTone, archived: boolean): ChainNode => ({
    key: nodeKey(type, id),
    type,
    id,
    title,
    status,
    tone,
    objectiveId: null,
    archived,
  })
  return [
    ...overview.objectives.map((o) => make("OBJECTIVE", o.id, o.title, o.status, toneOf(OBJECTIVE_TONE, o.status), false)),
    ...overview.opportunities.map((o) => make("OPPORTUNITY", o.id, o.title, o.status, toneOf(OPPORTUNITY_TONE, o.status), ARCHIVED_OPPORTUNITY.has(o.status))),
    ...overview.solutions.map((s) => make("SOLUTION", s.id, s.title, s.status, toneOf(SOLUTION_TONE, s.status), ARCHIVED_SOLUTION.has(s.status))),
    ...overview.assumptions.map((a) => make("ASSUMPTION", a.id, a.title, a.status, toneOf(ASSUMPTION_TONE, a.status), false)),
    ...overview.experiments.map((e) => make("EXPERIMENT", e.id, e.title, e.status, toneOf(EXPERIMENT_TONE, e.status), ARCHIVED_EXPERIMENT.has(e.status))),
    ...overview.roadmapItems.map((r) => make("ROADMAP_ITEM", r.id, r.title, r.horizon, toneOf(HORIZON_TONE, r.horizon), false)),
  ]
}

/** Per-type then global cap, chain order, archived last within a type. Returns the surviving keys and the report. */
function applyCaps(nodes: ChainNode[], globalCap: number, perTypeCap: number): { keep: Set<string>; truncated: TruncationInfo | null } {
  const keep = new Set<string>()
  const byType: TruncationInfo["byType"] = {}
  let remaining = Math.max(0, globalCap)
  let cut = false
  for (const type of CHAIN_NODE_TYPES) {
    const ofType = nodes.filter((n) => n.type === type)
    const ordered = [...ofType.filter((n) => !n.archived), ...ofType.filter((n) => n.archived)]
    const take = Math.min(ordered.length, Math.max(0, perTypeCap), remaining)
    for (const n of ordered.slice(0, take)) keep.add(n.key)
    remaining -= take
    if (take < ofType.length) cut = true
    if (ofType.length > 0) byType[type] = { shown: take, total: ofType.length }
  }
  return { keep, truncated: cut ? { byType, shown: keep.size, total: nodes.length } : null }
}

/** Nearest upstream Objective by BFS (an Objective is its own group). Deterministic: neighbours are visited in sorted key order. */
function assignObjectiveGroups(nodes: ChainNode[], edges: ChainEdge[]): ChainNode[] {
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    const list = parents.get(e.to)
    if (list) list.push(e.from)
    else parents.set(e.to, [e.from])
  }
  for (const list of parents.values()) list.sort()
  const typeOf = new Map(nodes.map((n) => [n.key, n]))

  return nodes.map((node) => {
    if (node.type === "OBJECTIVE") return { ...node, objectiveId: node.id }
    const seen = new Set<string>([node.key])
    let frontier = [node.key]
    while (frontier.length > 0) {
      const found = frontier.flatMap((k) => parents.get(k) ?? []).filter((k) => !seen.has(k))
      const unique = [...new Set(found)].sort()
      const objective = unique.find((k) => typeOf.get(k)?.type === "OBJECTIVE")
      if (objective) return { ...node, objectiveId: typeOf.get(objective)!.id }
      for (const k of unique) seen.add(k)
      frontier = unique
    }
    return node
  })
}

export function buildChainGraph(overview: CanvasOverview, options: BuildChainGraphOptions = {}): ChainGraph {
  const candidates = candidateNodes(overview)
  const keyById = new Map<string, string>()
  for (const n of candidates) keyById.set(n.id, n.key)
  // Key Result -> its Objective, so edges through a KR contract onto the Objective.
  for (const kr of overview.keyResults) {
    const objectiveKey = keyById.get(kr.objectiveId)
    if (objectiveKey) keyById.set(kr.id, objectiveKey)
  }

  const { keep, truncated } = applyCaps(candidates, options.globalCap ?? DEFAULT_GLOBAL_CAP, options.perTypeCap ?? DEFAULT_PER_TYPE_CAP)
  const nodeByKey = new Map(candidates.map((n) => [n.key, n]))

  const merged = new Map<string, ChainEdge>()
  for (const edge of buildCanvasEdges(overview, options.edgeOptions)) {
    const a = keyById.get(edge.source)
    const b = keyById.get(edge.target)
    if (!a || !b || a === b || !keep.has(a) || !keep.has(b)) continue
    const typeA = nodeByKey.get(a)!.type
    const typeB = nodeByKey.get(b)!.type
    const [from, to] = chainRank(typeA) <= chainRank(typeB) ? [a, b] : [b, a]
    const kind: ChainEdgeKind = edge.link ? "link" : edge.dashed ? "secondary" : "primary"
    const id = `${from}>${to}`
    const existing = merged.get(id)
    if (!existing || KIND_STRENGTH[kind] > KIND_STRENGTH[existing.kind]) merged.set(id, { id, from, to, kind })
  }
  const edges = [...merged.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))

  const nodes = assignObjectiveGroups(candidates.filter((n) => keep.has(n.key)), edges)
  return { nodes, edges, truncated }
}
