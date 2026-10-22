/**
 * Pure chain trace: upstream and downstream BFS from one node. Cycle-safe (visited sets), so the Objective->Objective
 * parent loop or a hand-made cycle terminates; a node is never reported as its own ancestor or descendant.
 */
import type { ChainGraph } from "./types"

export type GraphIndex = {
  /** node key -> outgoing edges as [edgeId, otherKey] */
  out: Map<string, Array<[string, string]>>
  inn: Map<string, Array<[string, string]>>
  keys: Set<string>
}

export function indexGraph(graph: Pick<ChainGraph, "nodes" | "edges">): GraphIndex {
  const out = new Map<string, Array<[string, string]>>()
  const inn = new Map<string, Array<[string, string]>>()
  const keys = new Set(graph.nodes.map((n) => n.key))
  const push = (m: Map<string, Array<[string, string]>>, k: string, v: [string, string]) => {
    const list = m.get(k)
    if (list) list.push(v)
    else m.set(k, [v])
  }
  for (const e of graph.edges) {
    if (!keys.has(e.from) || !keys.has(e.to)) continue
    push(out, e.from, [e.id, e.to])
    push(inn, e.to, [e.id, e.from])
  }
  return { out, inn, keys }
}

export type TraceResult = {
  selected: string
  /** Keys with their hop distance, nearest first, ties in discovery order. Excludes the selection. */
  upstream: Array<{ key: string; depth: number }>
  downstream: Array<{ key: string; depth: number }>
  /** Ids of the edges actually walked (not every edge between two traced nodes). */
  edgeIds: Set<string>
  /** selection + upstream + downstream */
  nodeKeys: Set<string>
}

export type TraceOptions = { maxDepth?: number }

function walk(start: string, adjacency: Map<string, Array<[string, string]>>, maxDepth: number, edgeIds: Set<string>) {
  const seen = new Set<string>([start])
  const found: Array<{ key: string; depth: number }> = []
  let frontier = [start]
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const key of frontier) {
      for (const [edgeId, other] of adjacency.get(key) ?? []) {
        edgeIds.add(edgeId)
        if (seen.has(other)) continue
        seen.add(other)
        found.push({ key: other, depth })
        next.push(other)
      }
    }
    frontier = next
  }
  return found
}

/** Returns null when `key` is not in the graph (callers treat that as "nothing selected"). */
export function traceChain(graph: GraphIndex | Pick<ChainGraph, "nodes" | "edges">, key: string, options: TraceOptions = {}): TraceResult | null {
  const index = "out" in graph ? graph : indexGraph(graph)
  if (!index.keys.has(key)) return null
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY
  const edgeIds = new Set<string>()
  const upstream = walk(key, index.inn, maxDepth, edgeIds)
  const downstream = walk(key, index.out, maxDepth, edgeIds)
  const nodeKeys = new Set<string>([key, ...upstream.map((u) => u.key), ...downstream.map((d) => d.key)])
  return { selected: key, upstream, downstream, edgeIds, nodeKeys }
}
