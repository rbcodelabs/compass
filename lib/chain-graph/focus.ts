/**
 * Focus (deep link) support: the pure neighbourhood cut, and the `?focus=` / panel-type vocabulary. The database half
 * (resolving a display ID to a row) reuses lib/work-item-resolve, so a display ID from another workspace is "not found"
 * exactly like a foreign UUID.
 */
import { resolveDisplayId, resolveWorkItem } from "@/lib/work-item-resolve"
import { classifyWorkItemRef, type WorkItemType } from "@/lib/work-item-ids"
import { indexGraph, traceChain } from "./trace"
import { nodeKey, type ChainGraph, type ChainNodeType } from "./types"

export const DEFAULT_FOCUS_DEPTH = 6
export const MAX_FOCUS_DEPTH = 12
/** Response cap for a focus fetch (design D2: same global cap as the workspace scope). */
export const FOCUS_NODE_CAP = 1500

export function clampDepth(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_FOCUS_DEPTH
  return Math.min(Math.max(Math.trunc(n), 1), MAX_FOCUS_DEPTH)
}

/** Panel entity types that are part of the v1 core chain, mapped to their chain node type. */
const PANEL_TO_CHAIN: Readonly<Record<string, ChainNodeType>> = {
  objective: "OBJECTIVE",
  opportunity: "OPPORTUNITY",
  solution: "SOLUTION",
  assumption: "ASSUMPTION",
  experiment: "EXPERIMENT",
  roadmapItem: "ROADMAP_ITEM",
}

const CHAIN_TO_WORK_ITEM: Readonly<Record<ChainNodeType, WorkItemType>> = {
  OBJECTIVE: "objective",
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ASSUMPTION: "assumption",
  EXPERIMENT: "experiment",
  ROADMAP_ITEM: "roadmapItem",
}

/** The `focus` query value for the detail panel's "View chain" action; null for types outside the core chain (keyResult has no node). */
export function chainFocusParam(panelType: string, id: string): string | null {
  const type = PANEL_TO_CHAIN[panelType]
  return type ? `${type}:${id}` : null
}

function chainTypeForWorkItem(type: WorkItemType): ChainNodeType | null {
  return (Object.keys(CHAIN_TO_WORK_ITEM) as ChainNodeType[]).find((t) => CHAIN_TO_WORK_ITEM[t] === type) ?? null
}

export type FocusRef = { type: ChainNodeType; ref: string } | { type: null; ref: string }

const TYPED = /^(OBJECTIVE|OPPORTUNITY|SOLUTION|ASSUMPTION|EXPERIMENT|ROADMAP_ITEM):([A-Za-z0-9-]{1,64})$/

/** `TYPE:<uuid or display id>` or a bare display id (`OPP-12`, whose prefix names the type). Null for anything else. */
export function parseFocusRef(raw: string | string[] | undefined): FocusRef | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null
  const typed = TYPED.exec(value)
  if (typed) return { type: typed[1] as ChainNodeType, ref: typed[2] }
  const bare = classifyWorkItemRef(value)
  // A display ID whose prefix is not a core-chain type (TASK-5) is refused here, before any lookup.
  return bare.kind === "display" && chainTypeForWorkItem(bare.parsed.type) ? { type: null, ref: value } : null
}

/** Resolves a focus reference inside `workspaceId` to a node key, or null (unknown, foreign, wrong type, or outside the core chain). */
export async function resolveFocusKey(db: object, workspaceId: string, focus: FocusRef): Promise<string | null> {
  if (focus.type) {
    const resolved = await resolveWorkItem(db, workspaceId, CHAIN_TO_WORK_ITEM[focus.type], focus.ref)
    return resolved.ok ? nodeKey(focus.type, resolved.id) : null
  }
  const resolved = await resolveDisplayId(db, workspaceId, focus.ref)
  if (!resolved.ok) return null
  const chainType = chainTypeForWorkItem(resolved.type)
  return chainType ? nodeKey(chainType, resolved.id) : null
}

/**
 * The chain around `key`: upstream and downstream up to `depth` hops, nearest first, cut to `cap` nodes with the cut
 * reported. Null when the key is not in the graph. Edges are the graph's own edges between kept nodes.
 */
export function focusSubgraph(graph: ChainGraph, key: string, depth: number = DEFAULT_FOCUS_DEPTH, cap: number = FOCUS_NODE_CAP): ChainGraph | null {
  const trace = traceChain(indexGraph(graph), key, { maxDepth: clampDepth(depth) })
  if (!trace) return null
  const order = [key, ...[...trace.upstream, ...trace.downstream].sort((a, b) => a.depth - b.depth).map((x) => x.key)]
  const kept = new Set(order.slice(0, Math.max(1, cap)))
  const nodes = graph.nodes.filter((n) => kept.has(n.key))
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to))
  const total = order.length
  return {
    nodes,
    edges,
    truncated: kept.size < total ? { byType: {}, shown: kept.size, total } : null,
  }
}
