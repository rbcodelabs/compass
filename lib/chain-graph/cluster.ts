/**
 * Pure projection: ChainGraph + view state -> what is actually drawn.
 *
 * Steps, in order: drop archived (unless shown) and hidden-type nodes, drop edges that lose an endpoint (no bridging, a
 * filtered-out middle node must not invent a parent->grandchild edge), bucket the rest by group, replace each collapsed
 * group with one cluster node, and aggregate edges between visible endpoints with a weight. Self-edges are dropped.
 *
 * Group colour is by `groupIndex`, the position in a stable ordering computed over the WHOLE graph (not the visible
 * subset), so a group keeps its series colour when filters change.
 */
import { CHAIN_NODE_TYPES, type ChainEdgeKind, type ChainGraph, type ChainNode, type ChainNodeType, type GroupBy, type StatusTone } from "./types"

export type ClusterView = {
  groupBy: GroupBy
  /** Group ids that are collapsed. */
  collapsed: ReadonlySet<string>
  hiddenTypes?: ReadonlySet<ChainNodeType>
  showArchived?: boolean
  /** A node key; its cluster is flagged so the renderer can keep the selection visible. */
  selection?: string | null
}

export type GroupInfo = {
  id: string
  label: string
  /** Stable index into the series palette. */
  index: number
  /** Visible member count (after type/archive filters). */
  count: number
  collapsed: boolean
}

export type ClusterNode = {
  kind: "cluster"
  key: string
  groupId: string
  label: string
  groupIndex: number
  count: number
  toneCounts: Record<StatusTone, number>
  containsSelection: boolean
}

export type MemberNode = { kind: "node"; key: string; node: ChainNode; groupId: string; groupIndex: number }

export type VisibleNode = ClusterNode | MemberNode

export type VisibleEdge = { id: string; from: string; to: string; kind: ChainEdgeKind; weight: number }

export type ClusterProjection = {
  nodes: VisibleNode[]
  edges: VisibleEdge[]
  groups: GroupInfo[]
  /** node key -> the visible key that represents it (itself, or its cluster). Hidden nodes are absent. */
  representative: Map<string, string>
}

export const UNASSIGNED_GROUP = "none"
const KIND_STRENGTH: Record<ChainEdgeKind, number> = { primary: 3, secondary: 2, link: 1 }

export function clusterKey(groupBy: GroupBy, groupId: string): string {
  return `cluster:${groupBy}:${groupId}`
}

export function groupIdOf(node: ChainNode, groupBy: GroupBy): string {
  if (groupBy === "type") return node.type
  if (groupBy === "status") return node.status
  return node.objectiveId ?? UNASSIGNED_GROUP
}

function humanize(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ")
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

type GroupMeta = { id: string; label: string; index: number }

/** Stable ordering over the whole graph: objective = graph order of Objectives, type = chain order, status = sorted. */
export function listGroups(graph: Pick<ChainGraph, "nodes">, groupBy: GroupBy): GroupMeta[] {
  if (groupBy === "type") {
    return CHAIN_NODE_TYPES.filter((t) => graph.nodes.some((n) => n.type === t)).map((t, index) => ({ id: t, label: humanize(t), index }))
  }
  if (groupBy === "status") {
    const statuses = [...new Set(graph.nodes.map((n) => n.status))].sort()
    return statuses.map((s, index) => ({ id: s, label: humanize(s), index }))
  }
  const metas: GroupMeta[] = []
  for (const n of graph.nodes) {
    if (n.type === "OBJECTIVE") metas.push({ id: n.id, label: n.title, index: metas.length })
  }
  if (graph.nodes.some((n) => n.objectiveId === null)) metas.push({ id: UNASSIGNED_GROUP, label: "No objective", index: metas.length })
  return metas
}

export function projectGraph(graph: ChainGraph, view: ClusterView): ClusterProjection {
  const metas = listGroups(graph, view.groupBy)
  const metaById = new Map(metas.map((m) => [m.id, m]))
  const metaFor = (id: string): GroupMeta => metaById.get(id) ?? { id, label: id === UNASSIGNED_GROUP ? "No objective" : id, index: metas.length }

  const visible = graph.nodes.filter((n) => (view.showArchived || !n.archived) && !view.hiddenTypes?.has(n.type))

  const members = new Map<string, ChainNode[]>()
  for (const n of visible) {
    const id = groupIdOf(n, view.groupBy)
    const list = members.get(id)
    if (list) list.push(n)
    else members.set(id, [n])
  }

  const nodes: VisibleNode[] = []
  const representative = new Map<string, string>()
  const groups: GroupInfo[] = []
  const emitted = new Set<string>()

  for (const n of visible) {
    const groupId = groupIdOf(n, view.groupBy)
    const meta = metaFor(groupId)
    const collapsed = view.collapsed.has(groupId)
    if (!collapsed) {
      nodes.push({ kind: "node", key: n.key, node: n, groupId, groupIndex: meta.index })
      representative.set(n.key, n.key)
      continue
    }
    const key = clusterKey(view.groupBy, groupId)
    representative.set(n.key, key)
    if (emitted.has(groupId)) continue
    emitted.add(groupId)
    const group = members.get(groupId) ?? []
    const toneCounts: Record<StatusTone, number> = { neutral: 0, info: 0, success: 0, warning: 0, danger: 0 }
    for (const m of group) toneCounts[m.tone] += 1
    nodes.push({
      kind: "cluster",
      key,
      groupId,
      label: meta.label,
      groupIndex: meta.index,
      count: group.length,
      toneCounts,
      containsSelection: !!view.selection && group.some((m) => m.key === view.selection),
    })
  }

  for (const [id, group] of members) {
    const meta = metaFor(id)
    groups.push({ id, label: meta.label, index: meta.index, count: group.length, collapsed: view.collapsed.has(id) })
  }
  groups.sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : 1))

  const aggregated = new Map<string, VisibleEdge>()
  for (const e of graph.edges) {
    const from = representative.get(e.from)
    const to = representative.get(e.to)
    if (!from || !to || from === to) continue
    const id = `${from}>${to}`
    const existing = aggregated.get(id)
    if (!existing) aggregated.set(id, { id, from, to, kind: e.kind, weight: 1 })
    else {
      existing.weight += 1
      if (KIND_STRENGTH[e.kind] > KIND_STRENGTH[existing.kind]) existing.kind = e.kind
    }
  }

  return { nodes, edges: [...aggregated.values()], groups, representative }
}

/**
 * Default collapse rule (design D3): when more than `threshold` elements would render, start with every group collapsed.
 * Returns the group ids to collapse (empty when the graph is small enough).
 */
export function defaultCollapsed(graph: ChainGraph, groupBy: GroupBy, threshold = 300): Set<string> {
  const shown = graph.nodes.filter((n) => !n.archived)
  if (shown.length <= threshold) return new Set()
  return new Set(listGroups({ nodes: shown }, groupBy).map((g) => g.id))
}
