/**
 * Deterministic synthetic ChainGraph for the renderer benchmark and tests. No randomness: shape is a pure function of
 * `objectives` and the fan-out constants, so a benchmark run is reproducible.
 */
import { hashUnit } from "./layout"
import { nodeKey, type ChainEdge, type ChainGraph, type ChainNode, type ChainNodeType, type StatusTone } from "./types"

const TONES: StatusTone[] = ["neutral", "info", "success", "warning", "danger"]
const STATUS_BY_TONE: Record<StatusTone, string> = { neutral: "IDEA", info: "IN_DELIVERY", success: "VALIDATED", warning: "UNTESTED", danger: "INVALIDATED" }

/** Per objective: 3 opportunities, 2 solutions each, 2 assumptions per solution, 1 experiment per assumption, 1 roadmap item per solution. */
export function syntheticChainGraph(targetNodes: number): ChainGraph {
  const perObjective = 1 + 3 + 6 + 12 + 12 + 6
  const objectives = Math.max(1, Math.round(targetNodes / perObjective))
  const nodes: ChainNode[] = []
  const edges: ChainEdge[] = []
  const add = (type: ChainNodeType, id: string, objectiveId: string, parent: string | null): string => {
    const key = nodeKey(type, id)
    const tone = TONES[Math.floor(hashUnit(id) * TONES.length)]
    nodes.push({ key, type, id, title: `${type.toLowerCase().replace("_", " ")} ${id}`, status: STATUS_BY_TONE[tone], tone, objectiveId, archived: false })
    if (parent) edges.push({ id: `${parent}>${key}`, from: parent, to: key, kind: "primary" })
    return key
  }
  for (let o = 0; o < objectives; o++) {
    const obj = `o${o}`
    const objKey = add("OBJECTIVE", obj, obj, null)
    for (let p = 0; p < 3; p++) {
      const oppKey = add("OPPORTUNITY", `${obj}-p${p}`, obj, objKey)
      for (let s = 0; s < 2; s++) {
        const solId = `${obj}-p${p}-s${s}`
        const solKey = add("SOLUTION", solId, obj, oppKey)
        add("ROADMAP_ITEM", `${solId}-r`, obj, solKey)
        for (let a = 0; a < 2; a++) {
          const asKey = add("ASSUMPTION", `${solId}-a${a}`, obj, solKey)
          add("EXPERIMENT", `${solId}-a${a}-e`, obj, asKey)
        }
      }
    }
  }
  // A few cross-links so the graph is not a pure forest: objective o -> first opportunity of objective o+1.
  for (let o = 0; o + 1 < objectives; o += 2) {
    const from = nodeKey("OBJECTIVE", `o${o}`)
    const to = nodeKey("OPPORTUNITY", `o${o + 1}-p0`)
    edges.push({ id: `${from}>${to}`, from, to, kind: "link" })
  }
  return { nodes, edges, truncated: null }
}
