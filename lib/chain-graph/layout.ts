/**
 * Deterministic force layout, settled before render (design D5). Pure given its inputs: the same nodes, edges and options
 * always yield the same positions (no Math.random: initial jitter is a hash of the node key, and d3-force's own source of
 * randomness is replaced with a seeded LCG). Positions are never pushed to React per tick; the caller gets the final map.
 *
 * Forces: Barnes-Hut many-body repulsion, links (weak across groups, so a view where most edges cross groups, such as
 * "Group by type", does not collapse the clouds together), collision by node radius, and a pull toward a per-group anchor so
 * each group forms a cloud. Anchors sit on a golden-angle spiral, spaced so estimated clouds do not touch. A final
 * deterministic pass then pushes any still-overlapping group circles (see groupCircles) apart, so separation is a property
 * of the result and not just a tendency of the forces.
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

const CROSS_GROUP_LINK_STRENGTH = 0.03
const GROUP_PULL = 0.14
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

/** Estimated cloud radius for a group of n nodes (used to space anchors; the real extent is settled by the separation pass). */
function cloudRadius(count: number): number {
  return 40 * Math.sqrt(count) + 40
}

/** Anchor per group, placed greedily along a golden-angle spiral at the first spot whose estimated cloud clears all earlier ones. */
export function groupAnchors(nodes: readonly LayoutNode[]): Map<string, Point> {
  const sizes = new Map<string, number>()
  const order: string[] = []
  for (const n of nodes) {
    if (!sizes.has(n.groupId)) order.push(n.groupId)
    sizes.set(n.groupId, (sizes.get(n.groupId) ?? 0) + 1)
  }
  const anchors = new Map<string, Point>()
  const placed: Array<{ p: Point; r: number }> = []
  order.forEach((id) => {
    const r = cloudRadius(sizes.get(id) ?? 1)
    let spot: Point = { x: 0, y: 0 }
    for (let step = placed.length === 0 ? 0 : 1; ; step++) {
      const radius = 24 * Math.sqrt(step) * 4
      const angle = step * GOLDEN_ANGLE
      spot = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
      if (placed.every((o) => Math.hypot(o.p.x - spot.x, o.p.y - spot.y) >= o.r + r + GROUP_GAP)) break
    }
    anchors.set(id, spot)
    placed.push({ p: spot, r })
  })
  return anchors
}

/** Padding between a group's members and its halo, and the minimum clear gap kept between two halos. */
export const HALO_PADDING = 36
export const GROUP_GAP = 16

export type GroupCircle = { id: string; cx: number; cy: number; r: number; count: number }

/**
 * Halo circle per group: centred on the member centroid, radius from the 90th-percentile member distance plus padding, so a
 * single outlier (a node dragged out by a cross-group link, or by the user) does not inflate the circle. Shared by the layout's
 * separation pass, the renderer (computed from live positions so halos follow drags) and the tests.
 */
export function groupCircles(items: Iterable<{ groupId: string; x: number; y: number }>): GroupCircle[] {
  const byGroup = new Map<string, Point[]>()
  for (const it of items) {
    const list = byGroup.get(it.groupId)
    if (list) list.push({ x: it.x, y: it.y })
    else byGroup.set(it.groupId, [{ x: it.x, y: it.y }])
  }
  return [...byGroup.entries()].map(([id, pts]) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const dist = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b)
    const p90 = dist[Math.max(0, Math.ceil(dist.length * 0.9) - 1)]
    return { id, cx, cy, r: p90 + HALO_PADDING, count: pts.length }
  })
}

/**
 * Pushes overlapping group circles apart by translating whole groups (never reshaping them). Groups holding a pinned node stay
 * put; if both circles are fixed they are left overlapping. Deterministic: fixed pair order, no randomness.
 */
function separateGroups(positions: Map<string, Point>, nodes: readonly LayoutNode[], fixed: ReadonlySet<string>): void {
  const members = new Map<string, string[]>()
  for (const n of nodes) {
    const list = members.get(n.groupId)
    if (list) list.push(n.key)
    else members.set(n.groupId, [n.key])
  }
  const frozen = new Set<string>()
  for (const [id, keys] of members) if (keys.some((k) => fixed.has(k))) frozen.add(id)
  const shift = (id: string, dx: number, dy: number) => {
    for (const k of members.get(id) ?? []) {
      const p = positions.get(k)
      if (p) positions.set(k, { x: p.x + dx, y: p.y + dy })
    }
  }
  for (let pass = 0; pass < 400; pass++) {
    const circles = groupCircles(nodes.map((n) => ({ groupId: n.groupId, ...positions.get(n.key)! })))
    let moved = false
    for (let i = 0; i < circles.length; i++) {
      for (let j = i + 1; j < circles.length; j++) {
        const a = circles[i]
        const b = circles[j]
        const need = a.r + b.r + GROUP_GAP
        let dx = b.cx - a.cx
        let dy = b.cy - a.cy
        let d = Math.hypot(dx, dy)
        if (d >= need - 0.01) continue
        if (frozen.has(a.id) && frozen.has(b.id)) continue
        if (d < 1e-6) {
          const angle = (i * 7 + j) * GOLDEN_ANGLE
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          d = 1
        }
        const push = need - d
        const ux = dx / d
        const uy = dy / d
        const share = frozen.has(a.id) || frozen.has(b.id) ? 1 : 0.5
        if (!frozen.has(a.id)) shift(a.id, -ux * push * share, -uy * push * share)
        if (!frozen.has(b.id)) shift(b.id, ux * push * share, uy * push * share)
        a.cx -= frozen.has(a.id) ? 0 : ux * push * share
        a.cy -= frozen.has(a.id) ? 0 : uy * push * share
        b.cx += frozen.has(b.id) ? 0 : ux * push * share
        b.cy += frozen.has(b.id) ? 0 : uy * push * share
        moved = true
      }
    }
    if (!moved) return
  }
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
        // Weak across groups: in "Group by type" nearly every edge crosses groups and a strong link would drag the clouds together.
        .strength((l) => ((l.source as SimNode).groupId === (l.target as SimNode).groupId ? 0.25 : CROSS_GROUP_LINK_STRENGTH)),
    )
    .force("collide", forceCollide<SimNode>((d) => d.radius + 4).strength(0.9))
    .force("x", forceX<SimNode>((d) => anchors.get(d.groupId)!.x).strength(GROUP_PULL))
    .force("y", forceY<SimNode>((d) => anchors.get(d.groupId)!.y).strength(GROUP_PULL))

  simulation.tick(options.ticks ?? defaultTicks(nodes.length))

  for (const node of sim) result.set(node.key, { x: node.x ?? 0, y: node.y ?? 0 })
  separateGroups(result, nodes, new Set(options.pinned?.keys() ?? []))
  for (const [key, p] of result) result.set(key, { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })
  return result
}
