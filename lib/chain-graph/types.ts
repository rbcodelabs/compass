/**
 * Chain graph read-model types (docs/design/chain-graph.md, D2). Framework-agnostic: nothing here knows about React,
 * React Flow or Prisma, so the renderer can be swapped without touching the pure modules.
 *
 * v1 scope is the core chain only: Objective -> Opportunity -> Solution -> Assumption -> Experiment -> Roadmap item.
 * Key Results are contracted away (see build.ts); tasks, feedback, docs and decisions are a later phase.
 */

/** Chain order. The index is the rank used to orient edges parent -> child. */
export const CHAIN_NODE_TYPES = ["OBJECTIVE", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "EXPERIMENT", "ROADMAP_ITEM"] as const
export type ChainNodeType = (typeof CHAIN_NODE_TYPES)[number]

export function chainRank(type: ChainNodeType): number {
  return CHAIN_NODE_TYPES.indexOf(type)
}

/** Maps onto the `status-*` token roles; the renderer never sees a raw color. */
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger"

export type ChainEdgeKind = "primary" | "secondary" | "link"

export type ChainNode = {
  /** "<TYPE>:<id>" */
  key: string
  type: ChainNodeType
  id: string
  title: string
  /** The object's own status string (or the roadmap horizon). */
  status: string
  tone: StatusTone
  /** The Objective this node ultimately hangs under (an Objective is its own group); null when it has no upstream Objective. */
  objectiveId: string | null
  archived: boolean
}

/** Always oriented parent -> child (lower chain rank to higher), so "downstream" means "further along the chain". */
export type ChainEdge = {
  id: string
  from: string
  to: string
  kind: ChainEdgeKind
}

export type TruncationInfo = {
  byType: Partial<Record<ChainNodeType, { shown: number; total: number }>>
  shown: number
  total: number
}

export type ChainGraph = {
  nodes: ChainNode[]
  edges: ChainEdge[]
  /** Null when nothing was cut. Truncation is always reported, never silent. */
  truncated: TruncationInfo | null
}

export type GroupBy = "objective" | "type" | "status"

export function nodeKey(type: ChainNodeType, id: string): string {
  return `${type}:${id}`
}
