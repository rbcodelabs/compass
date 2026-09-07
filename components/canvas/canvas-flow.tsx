"use client";

/**
 * The <ReactFlow> wrapper for the Canvas viewer — renders the full OST +
 * Roadmap graph in one eager pass (Objective -> KeyResult -> Opportunity ->
 * Solution -> Assumption -> Experiment, plus RoadmapItem), with real edges.
 *
 * Receives fetched overview data as props and computes layout client-side
 * on mount via computeCanvasLayout. `onlyRenderVisibleElements` is enabled
 * by default per the design doc's scale mitigation for large workspaces —
 * not a later optimization.
 *
 * Zoom-driven semantic tiers (see lib/canvas/tiers.ts) toggle `hidden` on
 * the already-laid-out nodes/edges via onMoveEnd — no re-layout, no
 * filtering of the underlying arrays. Still no click-to-focus animated
 * navigation, no URL deep-linking, no drag-to-pin UI — deferred to future
 * increments.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, Panel, MarkerType } from "@xyflow/react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Waypoints } from "lucide-react";
import { usePanelContext, type PanelType } from "@/components/panels/panel-context";
import {
  computeCanvasLayout,
  computeObjectiveGridPositions,
  NODE_SIZE,
  type CanvasLayoutInput,
  type CanvasNodeType,
  type GridPosition,
} from "@/lib/canvas/layout";
import { buildCanvasEdges } from "@/lib/canvas/edges";
import { getTierForZoom, isNodeTypeVisibleAtTier, TIER_LABELS, type CanvasTier } from "@/lib/canvas/tiers";
import { ObjectiveNode, type ObjectiveNodeType } from "@/components/canvas/objective-node";
import { KeyResultNode, type KeyResultNodeType } from "@/components/canvas/key-result-node";
import { OpportunityNode, type OpportunityNodeType } from "@/components/canvas/opportunity-node";
import { SolutionNode, type SolutionNodeType } from "@/components/canvas/solution-node";
import { AssumptionNode, type AssumptionNodeType } from "@/components/canvas/assumption-node";
import { ExperimentNode, type ExperimentNodeType } from "@/components/canvas/experiment-node";
import { RoadmapItemNode, type RoadmapItemNodeType } from "@/components/canvas/roadmap-item-node";
import type { CanvasOverview } from "@/lib/canvas/data";

const nodeTypes = {
  objective: ObjectiveNode,
  keyResult: KeyResultNode,
  opportunity: OpportunityNode,
  solution: SolutionNode,
  assumption: AssumptionNode,
  experiment: ExperimentNode,
  roadmapItem: RoadmapItemNode,
};

type CanvasFlowNode =
  | ObjectiveNodeType
  | KeyResultNodeType
  | OpportunityNodeType
  | SolutionNodeType
  | AssumptionNodeType
  | ExperimentNodeType
  | RoadmapItemNodeType;

interface CanvasFlowProps {
  overview: CanvasOverview;
}

// How long the T0<->detail position + camera animation runs, in ms. Both the
// per-node position tween and the programmatic camera move share this so they
// ease together and finish as one motion.
const TIER_TRANSITION_MS = 400;

// The T0 (Portfolio) auto-fit is capped below the T0/T1 zoom threshold (0.4,
// see tiers.ts) so that framing the compact grid always lands the viewport in
// the Portfolio band — never straddling up into Cycle — regardless of how few
// Objectives there are (a tiny grid would otherwise fit at a much higher
// zoom). Also floored at the interactive minZoom so a large grid still frames.
const T0_FIT_MAX_ZOOM = 0.35;
const T0_FIT_MIN_ZOOM = 0.2;
const T0_FIT_PADDING = 0.12;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Bounding box of the Objective cards at the given positions (top-left
// coords), inflated by the card size so the box covers whole cards.
function boundsOf(
  positions: Map<string, GridPosition>,
  ids: string[]
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = positions.get(id);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_SIZE.objective.width);
    maxY = Math.max(maxY, p.y + NODE_SIZE.objective.height);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

// Center point (flow coords) of the Objective cards at the given positions.
function centerOfPositions(
  positions: Map<string, GridPosition>,
  ids: string[]
): { x: number; y: number } {
  const b = boundsOf(positions, ids);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

// Zoom that frames the whole grid in the current pane, clamped into the
// Portfolio band (see T0_FIT_* constants). Falls back to the max cap if the
// pane hasn't been measured yet.
function gridFitZoom(
  positions: Map<string, GridPosition>,
  ids: string[],
  wrapper: HTMLElement | null
): number {
  const rect = wrapper?.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) return T0_FIT_MAX_ZOOM;
  const b = boundsOf(positions, ids);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (w === 0 || h === 0) return T0_FIT_MAX_ZOOM;
  const raw = Math.min(
    (rect.width * (1 - T0_FIT_PADDING)) / w,
    (rect.height * (1 - T0_FIT_PADDING)) / h
  );
  return Math.max(T0_FIT_MIN_ZOOM, Math.min(T0_FIT_MAX_ZOOM, raw));
}

// The Objective whose card (at its `from` position) sits nearest the current
// viewport center — the anchor a T0 -> detail exit recenters on, so the user
// dives into the Objective they were looking at rather than a random corner.
function nearestObjectiveToViewportCenter(
  fromPositions: Map<string, GridPosition>,
  ids: string[],
  rf: ReactFlowInstance,
  wrapper: HTMLElement | null
): string | null {
  const rect = wrapper?.getBoundingClientRect();
  if (!rect) return ids[0] ?? null;
  const center = rf.screenToFlowPosition({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
  let best: string | null = null;
  let bestDist = Infinity;
  for (const id of ids) {
    const p = fromPositions.get(id);
    if (!p) continue;
    const cx = p.x + NODE_SIZE.objective.width / 2;
    const cy = p.y + NODE_SIZE.objective.height / 2;
    const d = (cx - center.x) ** 2 + (cy - center.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

export function CanvasFlow({ overview }: CanvasFlowProps) {
  // The tier system is rooted in Objectives: T0 (Portfolio) is the grid of
  // Objectives, and each tier down reveals their descendants. A workspace with
  // *no* Objectives — e.g. a discovery-first one that has Opportunities,
  // Solutions, and Roadmap items but hasn't set OKRs yet — has no Portfolio to
  // show, so landing on T0 would render a blank canvas even though there's
  // plenty of content one tier down. In that case we disable tiering entirely:
  // pin to T2 (everything visible) and ignore zoom-driven tier changes, so
  // Canvas behaves like the plain full-graph view it was before tiers existed.
  const hasObjectives = overview.objectives.length > 0;

  // Clicking a node opens that entity's detail panel (see components/panels).
  const { openPanel } = usePanelContext();

  const [nodes, setNodes] = useState<CanvasFlowNode[] | null>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  // Default T0: the first paint is the compact Portfolio grid (see
  // computeObjectiveGridPositions). Unlike the old shared-layout T0 — which
  // showed Objectives scattered across the full ELK canvas and so had to
  // default to T2 to avoid flashing an empty view — the grid is always a
  // readable starting screen, so T0 is the natural landing tier. With no
  // Objectives there's no grid, so start (and stay) at T2 instead.
  const [tier, setTier] = useState<CanvasTier>(hasObjectives ? "T0" : "T2");

  // Current rendered position of each Objective, keyed by id. This is the one
  // piece of layout that animates: at rest it equals the grid position (T0)
  // or the ELK position (T1/T2); mid-transition it holds the interpolated
  // value written each animation frame. Non-Objective nodes never move — they
  // always render at their ELK position — so they stay out of this map.
  const [objectivePos, setObjectivePos] = useState<Map<string, GridPosition>>(
    () => new Map()
  );

  // The React Flow instance (captured via onInit) — needed to drive the
  // camera imperatively during a tier transition (setCenter with a duration).
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // Outer wrapper, measured to convert the viewport center into flow
  // coordinates when picking the focal Objective on a T0 -> detail exit.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Grid + ELK positions for Objectives, and the Objective id order, captured
  // once per layout so the transition effect can read them without recomputing.
  const gridPosRef = useRef<Map<string, GridPosition>>(new Map());
  const elkPosRef = useRef<Map<string, GridPosition>>(new Map());
  const objectiveIdsRef = useRef<string[]>([]);
  // Handle for the in-flight position tween's rAF loop, so a new transition
  // can cancel a still-running one.
  const rafRef = useRef<number | null>(null);
  // The last tier the transition effect acted on, so it can tell a genuine
  // T0<->detail boundary crossing (needs animation) from a T1<->T2 change
  // (visibility only, no movement).
  const prevTierRef = useRef<CanvasTier>(hasObjectives ? "T0" : "T2");

  const totalEntityCount =
    overview.objectives.length +
    overview.keyResults.length +
    overview.opportunities.length +
    overview.solutions.length +
    overview.assumptions.length +
    overview.experiments.length +
    overview.roadmapItems.length;

  useEffect(() => {
    let cancelled = false;

    const layoutInputs: CanvasLayoutInput[] = [
      ...overview.objectives.map((o) => ({ id: o.id, type: "objective" as CanvasNodeType, position: o.position })),
      ...overview.keyResults.map((kr) => ({ id: kr.id, type: "keyResult" as CanvasNodeType, position: kr.position })),
      ...overview.opportunities.map((o) => ({ id: o.id, type: "opportunity" as CanvasNodeType, position: o.position })),
      ...overview.solutions.map((s) => ({ id: s.id, type: "solution" as CanvasNodeType, position: s.position })),
      ...overview.assumptions.map((a) => ({ id: a.id, type: "assumption" as CanvasNodeType, position: a.position })),
      ...overview.experiments.map((e) => ({ id: e.id, type: "experiment" as CanvasNodeType, position: e.position })),
      ...overview.roadmapItems.map((r) => ({ id: r.id, type: "roadmapItem" as CanvasNodeType, position: r.position })),
    ];

    const canvasEdges = buildCanvasEdges(overview);

    computeCanvasLayout(layoutInputs, canvasEdges)
      .then((laidOut) => {
        if (cancelled) return;

        const objectiveById = new Map(overview.objectives.map((o) => [o.id, o]));
        const keyResultById = new Map(overview.keyResults.map((kr) => [kr.id, kr]));
        const opportunityById = new Map(overview.opportunities.map((o) => [o.id, o]));
        const solutionById = new Map(overview.solutions.map((s) => [s.id, s]));
        const assumptionById = new Map(overview.assumptions.map((a) => [a.id, a]));
        const experimentById = new Map(overview.experiments.map((e) => [e.id, e]));
        const roadmapItemById = new Map(overview.roadmapItems.map((r) => [r.id, r]));

        const keyResultsByObjectiveId = new Map<string, { current: number; target: number }[]>();
        for (const kr of overview.keyResults) {
          const list = keyResultsByObjectiveId.get(kr.objectiveId) ?? [];
          list.push({ current: kr.current, target: kr.target });
          keyResultsByObjectiveId.set(kr.objectiveId, list);
        }

        const computedNodes: CanvasFlowNode[] = [];

        for (const n of laidOut) {
          const position = { x: n.x, y: n.y };
          const size = NODE_SIZE[n.type];

          switch (n.type) {
            case "objective": {
              const obj = objectiveById.get(n.id);
              if (!obj) break;
              computedNodes.push({
                id: n.id,
                type: "objective",
                position,
                ...size,
                data: {
                  title: obj.title,
                  status: obj.status,
                  squad: obj.squad,
                  keyResults: keyResultsByObjectiveId.get(obj.id) ?? [],
                },
              });
              break;
            }
            case "keyResult": {
              const kr = keyResultById.get(n.id);
              if (!kr) break;
              computedNodes.push({
                id: n.id,
                type: "keyResult",
                position,
                ...size,
                data: { title: kr.title, current: kr.current, target: kr.target, unit: kr.unit },
              });
              break;
            }
            case "opportunity": {
              const opp = opportunityById.get(n.id);
              if (!opp) break;
              computedNodes.push({
                id: n.id,
                type: "opportunity",
                position,
                ...size,
                data: { title: opp.title, status: opp.status, squad: opp.squad },
              });
              break;
            }
            case "solution": {
              const sol = solutionById.get(n.id);
              if (!sol) break;
              computedNodes.push({
                id: n.id,
                type: "solution",
                position,
                ...size,
                data: { title: sol.title, status: sol.status },
              });
              break;
            }
            case "assumption": {
              const a = assumptionById.get(n.id);
              if (!a) break;
              computedNodes.push({
                id: n.id,
                type: "assumption",
                position,
                ...size,
                data: { title: a.title, riskLevel: a.riskLevel, status: a.status },
              });
              break;
            }
            case "experiment": {
              const exp = experimentById.get(n.id);
              if (!exp) break;
              computedNodes.push({
                id: n.id,
                type: "experiment",
                position,
                ...size,
                data: { title: exp.title, squad: exp.squad, status: exp.status, conclusion: exp.conclusion },
              });
              break;
            }
            case "roadmapItem": {
              const item = roadmapItemById.get(n.id);
              if (!item) break;
              computedNodes.push({
                id: n.id,
                type: "roadmapItem",
                position,
                ...size,
                data: { title: item.title, horizon: item.horizon, squad: item.squad, isBug: item.isBug },
              });
              break;
            }
          }
        }

        const computedEdges: Edge[] = canvasEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          markerEnd: { type: MarkerType.ArrowClosed },
          ...(e.dashed ? { style: { strokeDasharray: "5 5", opacity: 0.5 } } : {}),
        }));

        // Capture the two position sets the transition machinery switches
        // between: the ELK position each Objective already carries, and the
        // compact Portfolio grid computed just for Objectives. Objective id
        // order is preserved so the grid is stable across renders.
        const objectiveIds = computedNodes
          .filter((n) => n.type === "objective")
          .map((n) => n.id);
        const gridPos = computeObjectiveGridPositions(objectiveIds);
        const elkPos = new Map<string, GridPosition>(
          computedNodes
            .filter((n) => n.type === "objective")
            .map((n) => [n.id, { x: n.position.x, y: n.position.y }])
        );
        objectiveIdsRef.current = objectiveIds;
        gridPosRef.current = gridPos;
        elkPosRef.current = elkPos;
        prevTierRef.current = objectiveIds.length > 0 ? "T0" : "T2";

        setNodes(computedNodes);
        setEdges(computedEdges);
        // Start at the grid (initial tier is T0).
        setObjectivePos(new Map(gridPos));
      })
      .catch((err) => {
        // Layout is a pure client-side computation with no network I/O of
        // its own; a rejection here means a real bug (e.g. a malformed
        // input), not a transient failure worth retrying silently.
        console.error("[canvas] failed to compute layout:", err);
        if (!cancelled) {
          setNodes([]);
          setEdges([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [overview]);

  // Animate Objective positions (and choreograph the camera) whenever the
  // tier crosses the T0<->detail boundary. T1<->T2 changes move nothing —
  // Objectives sit at their ELK position in both — so they skip the animation
  // and only flip visibility. The layout itself is never recomputed here;
  // only the *choice* of which precomputed position set an Objective renders
  // at (grid vs. ELK) changes, tweened over TIER_TRANSITION_MS.
  useEffect(() => {
    const prev = prevTierRef.current;
    if (prev === tier) return;
    prevTierRef.current = tier;

    const wasT0 = prev === "T0";
    const isT0 = tier === "T0";
    // T1<->T2: visibility-only, no Objective movement, no camera choreography.
    if (wasT0 === isT0) return;

    const ids = objectiveIdsRef.current;
    if (ids.length === 0) return;

    const from = new Map(objectivePos);
    const to = isT0 ? gridPosRef.current : elkPosRef.current;

    // Cancel any tween still running from a rapid prior crossing.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    // --- Camera choreography (asymmetric) -----------------------------------
    // Entering T0: frame the whole compact grid (capped into the Portfolio
    // zoom band). Exiting T0: don't fit-all — that would frame the full ELK
    // canvas and zoom back out into T0, oscillating. Instead keep the user's
    // zoom and recenter on the Objective they were looking at, so they land
    // on real content (its neighborhood) rather than empty space.
    //
    // These setCenter calls deliberately preserve the tier: entering T0 lands
    // at gridFitZoom (always < 0.4, i.e. still T0), and exiting keeps the
    // user's current zoom (still the same detail tier). So the onMoveEnd that
    // fires when the animation settles just re-derives the same tier — a
    // no-op setState — which is why we don't (and mustn't) guard onMoveEnd
    // against it. An earlier version flipped a `transitioning` flag cleared in
    // the setCenter promise's .then(); when the user interrupted the camera
    // animation (a very normal thing — keep scrolling to zoom), the underlying
    // transition fired "interrupt" not "end", the promise never resolved, the
    // flag stuck true, and onMoveEnd ignored every subsequent zoom forever —
    // so zooming back out never returned to Portfolio. No flag = no way to get
    // wedged.
    const rf = rfRef.current;
    if (rf) {
      if (isT0) {
        const zoom = gridFitZoom(to, ids, wrapperRef.current);
        const c = centerOfPositions(to, ids);
        void rf.setCenter(c.x, c.y, { zoom, duration: TIER_TRANSITION_MS });
      } else {
        const focalId = nearestObjectiveToViewportCenter(
          from,
          ids,
          rf,
          wrapperRef.current
        );
        const target = (focalId && to.get(focalId)) || centerOfPositions(to, ids);
        const zoom = rf.getViewport().zoom;
        void rf.setCenter(
          target.x + NODE_SIZE.objective.width / 2,
          target.y + NODE_SIZE.objective.height / 2,
          { zoom, duration: TIER_TRANSITION_MS }
        );
      }
    }

    // --- Position tween -----------------------------------------------------
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const t = Math.min(1, (ts - startTs) / TIER_TRANSITION_MS);
      const e = easeInOutCubic(t);
      const next = new Map<string, GridPosition>();
      for (const id of ids) {
        const a = from.get(id) ?? to.get(id) ?? { x: 0, y: 0 };
        const b = to.get(id) ?? a;
        next.set(id, { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e) });
      }
      setObjectivePos(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    // objectivePos is intentionally read as a snapshot (`from`) at the start of
    // each transition, not tracked — including it would restart the tween on
    // every frame it writes. The effect keys off `tier` alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  // Clean up a running tween on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Node render list: Objectives render at their current animated position
  // (grid / ELK / mid-tween); every other node stays at its ELK position.
  // Visibility is a per-tier toggle, as before — the layout is never rebuilt.
  const visibleNodes = useMemo(() => {
    if (!nodes) return null;
    return nodes.map((n) => {
      const hidden = !isNodeTypeVisibleAtTier(n.type, tier);
      if (n.type === "objective") {
        const p = objectivePos.get(n.id);
        if (p) return { ...n, position: p, hidden };
      }
      return { ...n, hidden };
    });
  }, [nodes, tier, objectivePos]);

  const visibleNodeIds = useMemo(() => {
    if (!nodes) return new Set<string>();
    return new Set(
      nodes.filter((n) => isNodeTypeVisibleAtTier(n.type, tier)).map((n) => n.id)
    );
  }, [nodes, tier]);

  // Edge visibility is derived from its endpoints' node-type visibility
  // (not a separate per-edge tier tag) — every edge originates at KeyResult
  // or deeper, so hiding non-Objective nodes at T0 hides every edge too, and
  // hiding Opportunity-and-deeper nodes at T1 hides everything past
  // Objective -> KeyResult. No dangling half-visible edges to handle.
  const visibleEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        hidden: !(visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
      })),
    [edges, visibleNodeIds]
  );

  if (totalEntityCount === 0) {
    return (
      <div className="flex w-full h-full flex-col items-center justify-center gap-4 text-center">
        <div className="w-14 h-14 rounded-2xl bg-surface-inset flex items-center justify-center">
          <Waypoints className="w-7 h-7 text-text-subtle" />
        </div>
        <div>
          <p className="font-semibold text-text-primary">Nothing to show yet</p>
          <p className="text-sm text-text-subtle mt-1 max-w-xs mx-auto">
            Add Objectives and Key Results from the OKRs page to see them
            here.
          </p>
        </div>
      </div>
    );
  }

  if (nodes === null || visibleNodes === null) {
    return (
      <div className="flex w-full h-full items-center justify-center text-sm text-muted-foreground">
        Laying out canvas…
      </div>
    );
  }

  return (
    <div className="w-full h-full" ref={wrapperRef}>
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          // React Flow infers a node-specific instance generic from the
          // rendered nodes; we only call generic-agnostic viewport helpers
          // (setCenter / getViewport / screenToFlowPosition), so widen to the
          // base instance type for storage.
          rfRef.current = instance as unknown as ReactFlowInstance;
        }}
        onlyRenderVisibleElements
        // Click a node → open its detail panel. Node ids are the entity ids
        // and node.type is the entity type, so this maps straight through.
        onNodeClick={(_event, node) => openPanel(node.type as PanelType, node.id)}
        // React Flow's default minZoom is 0.5, which sits above the T0
        // tier threshold (zoom < 0.4, see lib/canvas/tiers.ts) — leaving it
        // at the default would make T0 physically unreachable by zooming
        // out. Lowered so all three tiers are actually reachable.
        minZoom={0.2}
        fitView
        // With Objectives, the initial fit frames the T0 grid (tier defaults
        // to T0, so only Objectives — at their grid positions — are visible);
        // cap the fit zoom below the T0/T1 threshold so a small grid doesn't
        // zoom in past Portfolio into Cycle. With no Objectives we're pinned at
        // T2 showing the full graph, so use the plain fit (no Portfolio cap) —
        // capping there would just leave the content awkwardly zoomed out.
        fitViewOptions={
          hasObjectives
            ? { maxZoom: T0_FIT_MAX_ZOOM, padding: T0_FIT_PADDING }
            : { padding: T0_FIT_PADDING }
        }
        // Tier is driven by onMoveEnd (fires once a pan/zoom gesture settles),
        // not continuous onMove — cheaper, avoids recomputing hidden-state on
        // every scroll tick. Our own transition setCenter calls preserve the
        // tier (see the transition effect), so their terminal onMoveEnd is a
        // harmless same-value setState — no guard needed. When there are no
        // Objectives, tiering is disabled — stay pinned at T2 (full graph)
        // regardless of zoom, so zooming out can't drop into an empty
        // Portfolio.
        onMoveEnd={(_event, viewport) => {
          if (!hasObjectives) return;
          setTier(getTierForZoom(viewport.zoom));
        }}
        // No drag-to-pin UI yet — nodes render at their computed layout
        // position and stay there. Explicit false avoids React Flow's
        // dev-mode warning about draggable/connectable nodes with no
        // onNodesChange/onConnect handlers.
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background />
        <Controls />
        {/* Read-only tier indicator — not a manual override control. Just
            enough for a user to understand why content appeared/disappeared
            as they zoomed. Uses React Flow's own <Panel> (top-left) rather
            than a manually-positioned absolute div — an earlier attempt at
            a hand-placed "bottom-left, offset up" div physically overlapped
            and blocked clicks on <Controls />'s zoom buttons (bottom-left);
            <Panel> keeps this in a different corner entirely, so it can
            never collide with Controls regardless of viewport size. */}
        <Panel
          position="top-left"
          className="rounded-md border border-border bg-background/90 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm"
        >
          {TIER_LABELS[tier]}
        </Panel>
      </ReactFlow>
    </div>
  );
}
