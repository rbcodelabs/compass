"use client"

/**
 * Chain graph renderer on @xyflow/react (design D3, option A). All graph logic lives in lib/chain-graph (build, trace,
 * cluster, layout); this component only maps {visible nodes, edges, settled positions} onto React Flow and owns view state.
 *
 * Layout is computed to settlement in the event handler that changes the view, then handed over static: positions are
 * never pushed to React per tick. Expand/collapse re-lays-out only the affected group (everything else is pinned at its
 * previous position, new members start at the cluster's old position). Drag-to-pin is session-only.
 */
import "@xyflow/react/dist/style.css"
import "./chain-graph.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Background, Controls, ReactFlow, ReactFlowProvider, ViewportPortal, useNodesState, useReactFlow, useStoreApi, type Edge } from "@xyflow/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { TypeGlyph } from "./type-glyph"
import { chainNodeTypes, type ChainRFNode, type ClusterRFNode } from "./chain-graph-nodes"
import { ChainGraphUiContext, type ChainGraphUi } from "./chain-graph-context"
import { CLUSTERS_ONLY_ABOVE, clusterKey, defaultCollapsed, listGroups, projectWithLimit, type ClusterProjection } from "@/lib/chain-graph/cluster"
import { groupCircles, layoutGraph, type LayoutNode, type Point } from "@/lib/chain-graph/layout"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { ALWAYS_SHOW_TIER_MAX, estimateLabelSize, labelTier, resolveLabelCollisions, type LabelCandidate } from "@/lib/chain-graph/label-collision"
import { seriesForGroupIndex, showsLabel, typeLabelsFor, zoomBand } from "@/lib/chain-graph/presentation"
import { indexGraph, traceChain } from "@/lib/chain-graph/trace"
import { CHAIN_NODE_TYPES, type ChainGraph, type ChainNodeType, type GroupBy } from "@/lib/chain-graph/types"

export type ChainGraphViewProps = {
  graph: ChainGraph
  /** A node key ("OPPORTUNITY:<id>") to select and centre on load. */
  initialFocus?: string | null
  initialGroupBy?: GroupBy
  /** "default" applies the >300 elements rule; "all"/"none" force the starting state (benchmark). */
  initialCollapse?: "default" | "all" | "none"
  /** Visible elements (nodes + edges) above which only clusters render. Defaults to the benchmarked budget; the benchmark passes Infinity. */
  elementLimit?: number
  /** Opens the shared detail panel. Omitted where no panel provider is mounted. */
  onOpenDetails?: (type: ChainNodeType, id: string) => void
  /** Exposes timings and viewport helpers on window.__chainGraphBench for the benchmark script. */
  benchHooks?: boolean
  className?: string
}

type View = { groupBy: GroupBy; collapsed: ReadonlySet<string>; hiddenTypes: ReadonlySet<ChainNodeType>; showArchived: boolean }
type Computed = { projection: ClusterProjection; positions: ReadonlyMap<string, Point> }

const GROUP_BY_LABEL = (objective: string): Record<GroupBy, string> => ({ objective, type: "Type", status: "Status" })
const NODE_RADIUS = 22

function limitNotice(elements: number, limit: number): string {
  return `Showing groups only: expanding everything would draw ${elements.toLocaleString()} elements, above the ${limit.toLocaleString()} limit. Hide a type or archived objects, or search and trace to narrow the view.`
}

function layoutNodesOf(projection: ClusterProjection): LayoutNode[] {
  return projection.nodes.map((v) => ({
    key: v.key,
    groupId: v.groupId,
    radius: v.kind === "cluster" ? 16 + 5 * Math.sqrt(v.count) : NODE_RADIUS,
  }))
}

/** Full layout, or an incremental one that only moves the groups whose collapsed state changed. */
function computeLayout(graph: ChainGraph, projection: ClusterProjection, prev: Computed | null, prevView: View | null, next: View, pins: ReadonlyMap<string, Point>): ReadonlyMap<string, Point> {
  const nodes = layoutNodesOf(projection)
  const edges = projection.edges.map((e) => ({ from: e.from, to: e.to, weight: e.weight }))
  const pinned = new Map<string, Point>(pins)
  const seed = new Map<string, Point>()

  if (prev && prevView && prevView.groupBy === next.groupBy) {
    const changed = new Set<string>()
    for (const id of new Set([...prevView.collapsed, ...next.collapsed])) if (prevView.collapsed.has(id) !== next.collapsed.has(id)) changed.add(id)
    for (const v of projection.nodes) {
      const old = prev.positions.get(v.key)
      if (old && !changed.has(v.groupId)) {
        pinned.set(v.key, old)
        continue
      }
      if (v.kind === "node" && changed.has(v.groupId)) {
        const from = prev.positions.get(clusterKey(next.groupBy, v.groupId))
        if (from) seed.set(v.key, from)
      }
    }
    // A newly collapsed cluster starts at the centroid of its members' previous positions.
    for (const v of projection.nodes) {
      if (v.kind !== "cluster" || seed.has(v.key)) continue
      const pts: Point[] = []
      for (const [key, rep] of projection.representative) if (rep === v.key) {
        const p = prev.positions.get(key)
        if (p) pts.push(p)
      }
      if (pts.length > 0) seed.set(v.key, { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length })
    }
  }
  return layoutGraph(nodes, edges, { seed, pinned })
}

function buildRFNodes(projection: ClusterProjection, positions: ReadonlyMap<string, Point>): Array<ChainRFNode | ClusterRFNode> {
  return projection.nodes.map((v) => {
    const position = positions.get(v.key) ?? { x: 0, y: 0 }
    return v.kind === "cluster"
      ? ({ id: v.key, type: "cluster", position, data: { visible: v }, draggable: true } satisfies ClusterRFNode)
      : ({ id: v.key, type: "chain", position, data: { visible: v }, draggable: true } satisfies ChainRFNode)
  })
}

function ChainGraphInner({ graph, initialFocus = null, initialGroupBy = "objective", initialCollapse = "default", elementLimit = CLUSTERS_ONLY_ABOVE, onOpenDetails, benchHooks, className }: ChainGraphViewProps) {
  const flow = useReactFlow()
  const labels = useLabels()
  const typeLabels = useMemo(() => typeLabelsFor(labels), [labels])
  const groupByLabel = GROUP_BY_LABEL(typeLabels.OBJECTIVE)
  const storeApi = useStoreApi()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const index = useMemo(() => indexGraph(graph), [graph])
  const edgeById = useMemo(() => new Map(graph.edges.map((e) => [e.id, e])), [graph])
  const nodeByKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph])

  const [initial] = useState(() => {
    const requested: View = {
      groupBy: initialGroupBy,
      collapsed: initialCollapse === "none" ? new Set<string>() : initialCollapse === "all" ? new Set(listGroups(graph, initialGroupBy).map((g) => g.id)) : defaultCollapsed(graph, initialGroupBy),
      hiddenTypes: new Set<ChainNodeType>(),
      // A deep link to an archived object must show it.
      showArchived: !!initialFocus && (graph.nodes.find((n) => n.key === initialFocus)?.archived ?? false),
    }
    return projectWithLimit(graph, requested, elementLimit)
  })
  const initialView = initial.view as View
  const [view, setView] = useState<View>(initialView)
  const [pins, setPins] = useState<ReadonlyMap<string, Point>>(() => new Map())
  const [computed, setComputed] = useState<Computed>(() => {
    const t0 = performance.now()
    const projection = initial.projection
    const positions = computeLayout(graph, projection, null, null, initialView, new Map())
    if (typeof window !== "undefined") (window as unknown as { __chainGraphLayoutMs?: number }).__chainGraphLayoutMs = performance.now() - t0
    return { projection, positions }
  })
  const [notice, setNotice] = useState(() => (initial.clustersOnly ? limitNotice(initial.requestedElements, elementLimit) : ""))
  const [initialNodes] = useState(() => buildRFNodes(computed.projection, computed.positions))
  const [nodes, setNodes, onNodesChange] = useNodesState<ChainRFNode | ClusterRFNode>(initialNodes)
  // Read in commitView without making it (and so the node context) change identity on every drag frame.
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  })
  const [selection, setSelection] = useState<string | null>(initialFocus)
  const [hideUnrelated, setHideUnrelated] = useState(false)
  const [query, setQuery] = useState("")
  const [announcement, setAnnouncement] = useState("")

  const commitView = useCallback(
    (patch: Partial<View>, nextPins: ReadonlyMap<string, Point> = pins, options: { refuseIfLimited?: boolean } = {}) => {
      const requested: View = { ...view, ...patch }
      const limited = projectWithLimit(graph, requested, elementLimit)
      if (limited.clustersOnly && options.refuseIfLimited) {
        setNotice(`Not expanded: that group would bring the view to ${limited.requestedElements.toLocaleString()} elements, above the ${elementLimit.toLocaleString()} limit. Hide a type or collapse another group first.`)
        return
      }
      const next = limited.view as View
      // A different grouping is a fresh arrangement: pins from the old one would freeze nodes at positions that make no sense here.
      const effectivePins = next.groupBy === view.groupBy ? nextPins : new Map<string, Point>()
      if (effectivePins !== nextPins) setPins(effectivePins)
      // Lay out from where nodes are NOW (drags included), not from the last settled layout, so a relayout never snaps a dragged node back.
      const live = new Map(computed.positions)
      for (const n of nodesRef.current) live.set(n.id, n.position)
      const positions = computeLayout(graph, limited.projection, { projection: computed.projection, positions: live }, view, next, effectivePins)
      setNotice(limited.clustersOnly ? limitNotice(limited.requestedElements, elementLimit) : "")
      setView(next)
      setComputed({ projection: limited.projection, positions })
      setNodes(buildRFNodes(limited.projection, positions))
    },
    [graph, view, computed, pins, setNodes, elementLimit],
  )

  const toggleGroup = useCallback(
    (groupId: string) => {
      const collapsed = new Set(view.collapsed)
      if (collapsed.has(groupId)) collapsed.delete(groupId)
      else collapsed.add(groupId)
      commitView({ collapsed }, undefined, { refuseIfLimited: view.collapsed.has(groupId) })
    },
    [view.collapsed, commitView],
  )

  const trace = useMemo(() => (selection && nodeByKey.has(selection) ? traceChain(index, selection) : null), [index, selection, nodeByKey])
  const { projection } = computed
  const selectedRep = selection ? (projection.representative.get(selection) ?? null) : null

  const traced = useMemo(() => {
    if (!trace) return null
    const set = new Set<string>()
    for (const k of trace.nodeKeys) {
      const rep = projection.representative.get(k)
      if (rep) set.add(rep)
    }
    return set
  }, [trace, projection])

  const tracedEdgeIds = useMemo(() => {
    if (!trace) return null
    const set = new Set<string>()
    for (const id of trace.edgeIds) {
      const e = edgeById.get(id)
      const from = e && projection.representative.get(e.from)
      const to = e && projection.representative.get(e.to)
      if (from && to && from !== to) set.add(`${from}>${to}`)
    }
    return set
  }, [trace, edgeById, projection])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const set = new Set<string>()
    for (const v of projection.nodes) if (v.kind === "node" && (v.node.title.toLowerCase().includes(q) || v.node.id.toLowerCase().includes(q))) set.add(v.key)
    return set
  }, [query, projection])

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = []
    for (const e of projection.edges) {
      const isTraced = tracedEdgeIds?.has(e.id) ?? false
      if (tracedEdgeIds && !isTraced && hideUnrelated) continue
      out.push({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "straight",
        focusable: false,
        selectable: false,
        className: cn(`chain-edge--${e.kind}`, isTraced && "chain-edge--traced", tracedEdgeIds && !isTraced && "chain-edge--dim"),
        style: e.weight > 1 ? { strokeWidth: Math.min(1 + Math.log2(e.weight), 5) } : undefined,
      })
    }
    return out
  }, [projection, tracedEdgeIds, hideUnrelated])

  const select = useCallback(
    (key: string | null) => {
      setSelection(key)
      if (!key) {
        setAnnouncement("Trace cleared")
        return
      }
      const node = nodeByKey.get(key)
      const t = traceChain(index, key)
      if (node && t) setAnnouncement(`Tracing ${node.title}: ${t.upstream.length} upstream, ${t.downstream.length} downstream`)
      else setAnnouncement("Cluster selected")
    },
    [index, nodeByKey],
  )

  const pinned = useMemo(() => new Set(pins.keys()), [pins])
  const ui = useMemo<ChainGraphUi>(
    () => ({ selectedRep, traced, hideUnrelated, matches, pinned, typeLabels, onSelect: (k) => select(k), onToggleGroup: toggleGroup }),
    [selectedRep, traced, hideUnrelated, matches, pinned, typeLabels, select, toggleGroup],
  )

  // Counter-scale cloud labels and set the semantic-zoom band on the root, both written outside React so zooming never re-renders nodes.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let band = ""
    const apply = (zoom: number) => {
      el.style.setProperty("--cg-inv-zoom", String(1 / Math.max(zoom, 0.05)))
      const next = zoomBand(zoom)
      if (next !== band) {
        band = next
        el.dataset.band = next
      }
    }
    apply(storeApi.getState().transform[2])
    return storeApi.subscribe((s) => apply(s.transform[2]))
  }, [storeApi])

  // Label collision culling (band "label" and "full"). Labels are counter-scaled to a constant screen size, so their boxes are
  // computed in screen space from the live node positions and viewport, then applied as data-cg-label on the node wrappers
  // outside React (a data attribute, because React Flow rewrites the wrapper's className on drag/select). Coalesced to one pass per frame.
  const labelInputs = useRef({ nodes, selectedRep, traced, matches, pinned, typeLabels })
  const scheduleLabelPass = useRef<() => void>(() => {})
  useEffect(() => {
    labelInputs.current = { nodes, selectedRep, traced, matches, pinned, typeLabels }
    scheduleLabelPass.current()
  }, [nodes, selectedRep, traced, matches, pinned, typeLabels])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let frame = 0
    let hovered: string | null = null

    const run = () => {
      frame = 0
      const [tx, ty, zoom] = storeApi.getState().transform
      const band = zoomBand(zoom)
      if (band === "dot") return
      const { nodes: current, selectedRep: sel, traced: tracedSet, matches: matchSet, pinned: pinnedSet, typeLabels: names } = labelInputs.current
      const width = el.clientWidth
      const height = el.clientHeight
      const candidates: LabelCandidate[] = []
      for (const n of current) {
        const v = n.data.visible
        const key = n.id
        const selected = sel === key
        const dim = (tracedSet !== null && !tracedSet.has(key)) || (v.kind === "node" && matchSet !== null && !matchSet.has(key))
        if (dim && !selected) continue
        if (!showsLabel(band, v.kind === "cluster" ? "cluster" : v.node.type)) continue
        const size = v.kind === "cluster" ? Math.round(26 + 5 * Math.sqrt(v.count)) : v.node.type === "OBJECTIVE" ? 24 : 18
        const cx = (n.position.x + size / 2) * zoom + tx
        const cy = (n.position.y + size / 2) * zoom + ty
        let box: { width: number; height: number }
        let x: number
        let y: number
        if (v.kind === "cluster") {
          const detail = band === "full" ? (Object.entries(v.toneCounts) as Array<[string, number]>).filter(([, c]) => c > 0).map(([tone, c]) => `${c} ${tone}`).join(" ") : null
          box = estimateLabelSize(v.label, detail)
          x = cx - box.width / 2
          y = cy + (size / 2 + 4) * zoom
        } else {
          box = estimateLabelSize(v.node.title, band === "full" ? `${names[v.node.type]} · ${v.node.status}` : null)
          x = cx + (size / 2 + 8) * zoom
          y = cy - box.height / 2
        }
        if (x > width + 40 || x + box.width < -40 || y > height + 40 || y + box.height < -40) continue
        const tier = labelTier({
          selected,
          hovered: hovered === key,
          traced: tracedSet?.has(key) ?? false,
          matched: matchSet?.has(key) ?? false,
          pinned: pinnedSet.has(key),
          keyType: v.kind === "cluster" || v.node.type === "OBJECTIVE" || v.node.type === "OPPORTUNITY",
        })
        candidates.push({ key, tier, alwaysShow: tier <= ALWAYS_SHOW_TIER_MAX, x, y, ...box })
      }
      const shown = resolveLabelCollisions(candidates)
      for (const dom of el.querySelectorAll<HTMLElement>(".react-flow__node")) {
        const want = dom.dataset.id && shown.has(dom.dataset.id) ? "on" : "off"
        if (dom.dataset.cgLabel !== want) dom.dataset.cgLabel = want
      }
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run)
    }
    scheduleLabelPass.current = schedule
    const setHovered = (next: string | null) => {
      if (next === hovered) return
      hovered = next
      schedule()
    }
    const onOver = (e: PointerEvent) => setHovered((e.target as Element | null)?.closest?.(".react-flow__node")?.getAttribute("data-id") ?? null)
    const onLeave = () => setHovered(null)
    el.addEventListener("pointerover", onOver)
    el.addEventListener("pointerleave", onLeave)
    const unsubscribe = storeApi.subscribe(schedule)
    schedule()
    return () => {
      el.removeEventListener("pointerover", onOver)
      el.removeEventListener("pointerleave", onLeave)
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
      scheduleLabelPass.current = () => {}
    }
  }, [storeApi])

  useEffect(() => {
    if (!initialFocus) return
    const id = setTimeout(() => {
      const rep = projection.representative.get(initialFocus)
      if (rep) void flow.fitView({ nodes: [{ id: rep }], maxZoom: 1.2, duration: 0 })
    }, 0)
    return () => clearTimeout(id)
    // initial focus only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!benchHooks) return
    ;(window as unknown as Record<string, unknown>).__chainGraphBench = {
      ready: true,
      nodes: nodes.length,
      edges: edges.length,
      layoutMs: (window as unknown as { __chainGraphLayoutMs?: number }).__chainGraphLayoutMs ?? null,
      setViewport: (x: number, y: number, zoom: number) => flow.setViewport({ x, y, zoom }, { duration: 0 }),
      select: (key: string | null) => select(key),
      collapseAll: () => commitView({ collapsed: new Set(listGroups(graph, view.groupBy).map((g) => g.id)) }),
      expandAll: () => commitView({ collapsed: new Set() }),
    }
  })

  const togglePin = useCallback(
    (key: string, position?: Point) => {
      const next = new Map(pins)
      if (next.has(key) && !position) next.delete(key)
      else {
        const p = position ?? flow.getNode(key)?.position
        if (p) next.set(key, { x: p.x, y: p.y })
      }
      setPins(next)
    },
    [pins, flow],
  )

  const neighbour = useCallback(
    (direction: "up" | "down") => {
      if (!selection) return
      const list = (direction === "up" ? index.inn : index.out).get(selection)
      const target = list?.map(([, k]) => k).find((k) => projection.representative.has(k))
      if (!target) return
      select(target)
      const rep = projection.representative.get(target)
      if (rep) void flow.fitView({ nodes: [{ id: rep }], duration: 0, maxZoom: Math.max(flow.getZoom(), 0.8) })
    },
    [selection, index, projection, select, flow],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        if (e.key === "Escape") (target as HTMLInputElement).blur()
        return
      }
      if (e.key === "Escape") select(null)
      else if (e.key === "/") {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === "p" || e.key === "P") {
        if (selectedRep) togglePin(selectedRep)
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") neighbour("up")
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") neighbour("down")
      else if (e.key === "0") void flow.fitView({ duration: 0 })
      else if (e.key === "+" || e.key === "=") void flow.zoomIn({ duration: 0 })
      else if (e.key === "-") void flow.zoomOut({ duration: 0 })
    },
    [select, selectedRep, togglePin, neighbour, flow],
  )

  // Halos are computed from the live node positions (React Flow's own state), so they follow a drag as it happens.
  const halos = useMemo(() => {
    const groupInfo = new Map(projection.groups.map((g) => [g.id, g]))
    const indexOf = new Map<string, number>()
    const live: Array<{ groupId: string; x: number; y: number }> = []
    for (const n of nodes) {
      const v = n.data.visible
      if (v.kind !== "node") continue
      indexOf.set(v.groupId, v.groupIndex)
      live.push({ groupId: v.groupId, x: n.position.x, y: n.position.y })
    }
    return groupCircles(live).map((c) => ({ ...c, index: indexOf.get(c.id) ?? 0, label: groupInfo.get(c.id)?.label ?? c.id }))
  }, [projection, nodes])

  const allGroupIds = useMemo(() => listGroups(graph, view.groupBy).map((g) => g.id), [graph, view.groupBy])
  const toggleType = (type: ChainNodeType) => {
    const hiddenTypes = new Set(view.hiddenTypes)
    if (hiddenTypes.has(type)) hiddenTypes.delete(type)
    else hiddenTypes.add(type)
    commitView({ hiddenTypes })
  }

  const trunc = graph.truncated

  return (
    <div className={cn("chain-graph flex h-full min-h-0 flex-col gap-3 md:flex-row", className)} onKeyDown={onKeyDown}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="toolbar" aria-label="Graph controls">
          <div className="flex items-center gap-2">
            <Label htmlFor="chain-group-by" className="text-xs text-text-subtle">Group by</Label>
            <Select
              value={view.groupBy}
              onValueChange={(value) => {
                if (!value) return
                const groupBy = value as GroupBy
                commitView({ groupBy, collapsed: defaultCollapsed(graph, groupBy) })
              }}
            >
              <SelectTrigger id="chain-group-by" className="w-32" aria-label="Group by">
                <SelectValue>{groupByLabel[view.groupBy]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(groupByLabel) as GroupBy[]).map((g) => (
                  <SelectItem key={g} value={g}>{groupByLabel[g]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Object types">
            {CHAIN_NODE_TYPES.map((type) => (
              <Button key={type} size="xs" variant={view.hiddenTypes.has(type) ? "outline" : "secondary"} aria-pressed={!view.hiddenTypes.has(type)} onClick={() => toggleType(type)}>
                <TypeGlyph type={type} dimmed={view.hiddenTypes.has(type)} />
                {typeLabels[type]}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Switch id="chain-hide-unrelated" size="sm" checked={hideUnrelated} onCheckedChange={setHideUnrelated} />
            <Label htmlFor="chain-hide-unrelated" className="text-xs">Hide unrelated</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="chain-show-archived" size="sm" checked={view.showArchived} onCheckedChange={(showArchived) => commitView({ showArchived })} />
            <Label htmlFor="chain-show-archived" className="text-xs">Show archived</Label>
          </div>
          <Button size="xs" variant="outline" onClick={() => commitView({ collapsed: new Set(allGroupIds) })}>Collapse all</Button>
          <Button size="xs" variant="outline" onClick={() => commitView({ collapsed: new Set() })}>Expand all</Button>
          <Input ref={searchRef} className="h-7 w-48" aria-label="Search objects" placeholder="Search ( / )" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {notice && (
          <p className="text-xs text-status-warning" role="status" data-testid="chain-graph-limit-notice">
            {notice}
          </p>
        )}
        {trunc && (
          <p className="text-xs text-status-warning" role="status">
            Showing {trunc.shown.toLocaleString()} of {trunc.total.toLocaleString()} objects. Narrow with filters or collapse groups.
          </p>
        )}
        <div ref={rootRef} className="relative hidden min-h-[320px] flex-1 overflow-hidden rounded-lg border border-border-default md:block" data-testid="chain-graph-canvas">
          <ChainGraphUiContext.Provider value={ui}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={chainNodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_, node) => togglePin(node.id, node.position)}
              onPaneClick={() => select(null)}
              onlyRenderVisibleElements
              nodesConnectable={false}
              elementsSelectable={false}
              minZoom={0.05}
              maxZoom={3}
              fitView
              proOptions={{ hideAttribution: true }}
              aria-label="Chain graph"
            >
              <Background gap={32} />
              <Controls showInteractive={false} />
              <ViewportPortal>
                {halos.map((h) => (
                  <div
                    key={h.id}
                    className="chain-halo"
                    style={{
                      transform: `translate(${h.cx - h.r}px, ${h.cy - h.r}px)`,
                      width: h.r * 2,
                      height: h.r * 2,
                      background: `color-mix(in oklch, var(--graph-series-${seriesForGroupIndex(h.index)}) 10%, transparent)`,
                      border: `1px solid color-mix(in oklch, var(--graph-series-${seriesForGroupIndex(h.index)}) 35%, transparent)`,
                    }}
                  >
                    <Button size="xs" variant="outline" className="chain-halo__label" aria-expanded onClick={() => toggleGroup(h.id)}>
                      {h.label} ({h.count})
                    </Button>
                  </div>
                ))}
              </ViewportPortal>
            </ReactFlow>
          </ChainGraphUiContext.Provider>
        </div>
      </div>
      <Outline typeLabels={typeLabels} graph={graph} trace={trace} selection={selection} query={query} onSelect={(k) => select(k)} onOpenDetails={onOpenDetails} nodeByKey={nodeByKey} announcement={announcement} />
    </div>
  )
}

type OutlineProps = {
  typeLabels: Record<ChainNodeType, string>
  graph: ChainGraph
  trace: ReturnType<typeof traceChain>
  selection: string | null
  query: string
  nodeByKey: ReadonlyMap<string, ChainGraph["nodes"][number]>
  announcement: string
  onSelect: (key: string) => void
  onOpenDetails?: (type: ChainNodeType, id: string) => void
}

const OUTLINE_LIMIT = 200

/** The accessible representation of the graph: ordered upstream / selection / downstream lists, also the small-screen path. */
function Outline({ typeLabels, graph, trace, selection, query, nodeByKey, announcement, onSelect, onOpenDetails }: OutlineProps) {
  const row = (key: string) => {
    const node = nodeByKey.get(key)
    if (!node) return null
    return (
      <li key={key} className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-auto min-w-0 flex-1 justify-start py-1 text-left" aria-current={key === selection ? "true" : undefined} onClick={() => onSelect(key)}>
          <span className="min-w-0 truncate">
            <span className="text-text-subtle">{typeLabels[node.type]} · </span>
            {node.title}
          </span>
        </Button>
        {onOpenDetails && (
          <Button variant="outline" size="xs" aria-label={`Open details for ${node.title}`} onClick={() => onOpenDetails(node.type, node.id)}>
            Open
          </Button>
        )}
      </li>
    )
  }
  const q = query.trim().toLowerCase()
  const found = !trace && q ? graph.nodes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 50) : []
  const upstream = trace ? [...trace.upstream].sort((a, b) => b.depth - a.depth).slice(0, OUTLINE_LIMIT) : []
  const downstream = trace ? trace.downstream.slice(0, OUTLINE_LIMIT) : []

  return (
    <aside aria-label="Chain outline" className="flex max-h-72 min-h-0 w-full shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border-default bg-surface-panel p-3 md:max-h-none md:w-72">
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      {!trace && !q && <p className="text-sm text-text-subtle">Select an object to trace its chain, or search by title. {graph.nodes.length.toLocaleString()} objects loaded.</p>}
      {!trace && q && (
        <section aria-label="Search results">
          <h2 className="text-xs font-medium uppercase text-text-subtle">Matches</h2>
          <ul className="mt-1 space-y-0.5">{found.map((n) => row(n.key))}</ul>
          {found.length === 0 && <p className="text-sm text-text-subtle">No matches.</p>}
        </section>
      )}
      {trace && (
        <>
          <section aria-label="Upstream">
            <h2 className="text-xs font-medium uppercase text-text-subtle">Upstream ({trace.upstream.length})</h2>
            <ul className="mt-1 space-y-0.5">{upstream.map((u) => row(u.key))}</ul>
          </section>
          <section aria-label="Selection">
            <h2 className="text-xs font-medium uppercase text-text-subtle">Selection</h2>
            <ul className="mt-1 space-y-0.5">{row(trace.selected)}</ul>
          </section>
          <section aria-label="Downstream">
            <h2 className="text-xs font-medium uppercase text-text-subtle">Downstream ({trace.downstream.length})</h2>
            <ul className="mt-1 space-y-0.5">{downstream.map((d) => row(d.key))}</ul>
          </section>
        </>
      )}
    </aside>
  )
}

export function ChainGraphView(props: ChainGraphViewProps) {
  return (
    <ReactFlowProvider>
      <ChainGraphInner {...props} />
    </ReactFlowProvider>
  )
}
