import type { JsonCanvas } from "@/lib/json-canvas"

export type CanvasDiff = {
  addedNodes: string[]
  removedNodes: string[]
  /** Same id, different position or size: animated as a move. */
  movedNodes: string[]
  /** Same id, other content (text, color, file, ...): swapped in place without motion. */
  changedNodes: string[]
  addedEdges: string[]
  removedEdges: string[]
  changedEdges: string[]
}

/** Diff two canvases by node and edge id. Order changes alone (z-order) are not reported. */
export function diffCanvas(prev: JsonCanvas, next: JsonCanvas): CanvasDiff {
  const prevNodes = new Map(prev.nodes.map((node) => [node.id, node]))
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]))
  const prevEdges = new Map(prev.edges.map((edge) => [edge.id, edge]))
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]))
  const diff: CanvasDiff = { addedNodes: [], removedNodes: [], movedNodes: [], changedNodes: [], addedEdges: [], removedEdges: [], changedEdges: [] }
  const withoutBox = (node: JsonCanvas["nodes"][number]) => {
    const rest: Record<string, unknown> = { ...node }
    for (const key of ["x", "y", "width", "height"]) delete rest[key]
    return JSON.stringify(rest)
  }
  for (const [id, node] of nextNodes) {
    const before = prevNodes.get(id)
    if (!before) { diff.addedNodes.push(id); continue }
    if (before.x !== node.x || before.y !== node.y || before.width !== node.width || before.height !== node.height) diff.movedNodes.push(id)
    if (withoutBox(before) !== withoutBox(node)) diff.changedNodes.push(id)
  }
  for (const id of prevNodes.keys()) if (!nextNodes.has(id)) diff.removedNodes.push(id)
  for (const [id, edge] of nextEdges) {
    const before = prevEdges.get(id)
    if (!before) diff.addedEdges.push(id)
    else if (JSON.stringify(before) !== JSON.stringify(edge)) diff.changedEdges.push(id)
  }
  for (const id of prevEdges.keys()) if (!nextEdges.has(id)) diff.removedEdges.push(id)
  return diff
}

export function isCanvasDiffEmpty(diff: CanvasDiff): boolean {
  return Object.values(diff).every((ids) => ids.length === 0)
}
