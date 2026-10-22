/**
 * Deterministic force layout, settled before render (design D5). Pure given its inputs: the same nodes, edges and options
 * always yield the same positions (no Math.random: initial jitter is a hash of the node key, and d3-force's own source of
 * randomness is replaced with a seeded LCG). Positions are never pushed to React per tick; the caller gets the final map.
 *
 * Forces: Barnes-Hut many-body repulsion, links, collision by node radius, and a pull toward a per-group anchor so each
 * group forms a cloud. Anchors sit on a golden-angle spiral ordered by group index, spaced by the group's size.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force"

export type LayoutNode = { key: string; groupId: string; radius: number }
export type LayoutEdge = { from: string; to: string; weight?: number }
export type Point = { x: number; y: number }

export type LayoutOptions = {
  /** Starting positions (e.g. the previous layout, or a cluster's old position for its new members). */
  seed?: ReadonlyMap<string, Point>
  /** Nodes held fixed (drag-to-pin, or everything outside a group being re-laid-out). */
  pinned?: ReadonlyMap<string, Point>
  /** Fixed tick budget. Default settles alpha fully. */
  ticks?: number
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/**
 * Settle budget by size. The simulation runs on the main thread (a worker is a later phase), and cost grows with nodes x ticks
 * (about 1.7 s for 1,000 nodes at 300 ticks), so larger graphs get fewer ticks.
 */
export function defaultTicks(nodeCount: number): number {
  if (nodeCount <= 400) return 300
  if (nodeCount <= 800) return 200
  return 120
}

/** FNV-1a, mapped to [0, 1). Stable across runs and platforms. */
export function hashUnit(input: string, salt = 0): number {
  let h = (0x811c9dc5 ^ salt) >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 0x100000000
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** Anchor per group on a golden-angle spiral; bigger groups push the spiral outward so clouds do not overlap. */
export function groupAnchors(nodes: readonly LayoutNode[]): Map<string, Point> {
  const sizes = new Map<string, number>()
  const order: string[] = []
  for (const n of nodes) {
    if (!sizes.has(n.groupId)) order.push(n.groupId)
    sizes.set(n.groupId, (sizes.get(n.groupId) ?? 0) + 1)
  }
  const anchors = new Map<string, Point>()
  let travelled = 0
  order.forEach((id, i) => {
    const cloud = 52 * Math.sqrt(sizes.get(id) ?? 1) + 40
    // Radius grows with the cumulative cloud area so far (sum of previous clouds), keeping spacing proportional to size.
    const radius = i === 0 ? 0 : Math.sqrt(travelled) * 1.9
    const angle = i * GOLDEN_ANGLE
    anchors.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
    travelled += cloud * cloud
  })
  return anchors
}

type SimNode = SimulationNodeDatum & { key: string; groupId: string; radius: number }

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: LayoutOptions = {}): Map<string, Point> {
  const result = new Map<string, Point>()
  if (nodes.length === 0) return result

  const anchors = groupAnchors(nodes)
  const sim: SimNode[] = nodes.map((n) => {
    const anchor = anchors.get(n.groupId)!
    const seed = options.seed?.get(n.key)
    const spread = 18 * Math.sqrt(nodes.length) / 4 + 30
    return {
      key: n.key,
      groupId: n.groupId,
      radius: n.radius,
      x: seed?.x ?? anchor.x + (hashUnit(n.key, 1) - 0.5) * spread,
      y: seed?.y ?? anchor.y + (hashUnit(n.key, 2) - 0.5) * spread,
    }
  })
  for (const node of sim) {
    const pin = options.pinned?.get(node.key)
    if (pin) {
      node.x = pin.x
      node.y = pin.y
      node.fx = pin.x
      node.fy = pin.y
    }
  }

  const known = new Set(sim.map((n) => n.key))
  const links: Array<SimulationLinkDatum<SimNode> & { weight: number }> = edges
    .filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to))
    .map((e) => ({ source: e.from, target: e.to, weight: e.weight ?? 1 }))

  const simulation = forceSimulation<SimNode>(sim)
    .randomSource(seededRandom(0x5eed))
    .stop()
    .force("charge", forceManyBody<SimNode>().strength(-110).theta(0.9).distanceMax(500))
    .force(
      "link",
      forceLink<SimNode, (typeof links)[number]>(links)
        .id((d) => d.key)
        .distance(70)
        .strength(0.25),
    )
    .force("collide", forceCollide<SimNode>((d) => d.radius + 4).strength(0.9))
    .force("x", forceX<SimNode>((d) => anchors.get(d.groupId)!.x).strength(0.09))
    .force("y", forceY<SimNode>((d) => anchors.get(d.groupId)!.y).strength(0.09))

  simulation.tick(options.ticks ?? defaultTicks(nodes.length))

  for (const node of sim) result.set(node.key, { x: Math.round((node.x ?? 0) * 100) / 100, y: Math.round((node.y ?? 0) * 100) / 100 })
  return result
}
