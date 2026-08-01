/**
 * Pin-aware ELK layout wrapper for the Canvas viewer's full OST + Roadmap
 * graph (Objective -> KeyResult -> Opportunity -> Solution -> Assumption ->
 * Experiment, plus RoadmapItem).
 *
 * Pure data in/out — no Prisma, no React Flow types — so it's fully
 * unit-testable without mocking anything. Layout only carries
 * `{id, type, position}` per node; full entity data (title, status, etc.)
 * stays out of this round-trip and gets joined back in canvas-flow.tsx.
 *
 * Every node is partitioned into pinned (a user has explicitly saved a
 * {x,y} for it — CanvasNodePosition has no writer yet, so this is always
 * empty today, but the partition exists so a future drag-to-pin UI doesn't
 * need to touch this function's core logic) vs. unpinned (ELK computes
 * placement). Pinned nodes are still handed to ELK — with their saved
 * position and `elk.interactive: true` — so the unpinned layout can account
 * for them, but the *returned* coordinates for a pinned node are always its
 * saved {x,y} verbatim, never whatever ELK nudges it to.
 */
import ElkConstructor from "elkjs/lib/elk-api";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";

// elkjs's default entry point (`elkjs`, aka lib/main.js) probes for an
// optional `web-worker` package via a bare `require("web-worker")` that we
// don't install — harmless at runtime (it's wrapped in try/catch and falls
// back to the synchronous elk-worker.min.js implementation), but Turbopack's
// static analysis of that require() call fails `next build` outright since
// the module doesn't exist. Constructing the base ELK class directly with
// elk-worker's synchronous fallback Worker sidesteps the probe entirely —
// this is exactly what elkjs's own default export falls back to anyway.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Worker: ElkSyncWorker } = require("elkjs/lib/elk-worker.js");

const elk = new ElkConstructor({
  // elk-worker.js's synchronous fake Worker isn't the DOM `Worker` type
  // elkjs's own .d.ts expects (it never runs in an actual thread) — cast
  // is safe since ELK only ever calls `.postMessage`/`.onmessage` on it,
  // both of which the fake implements.
  workerFactory: (url?: string) => new ElkSyncWorker(url) as Worker,
});

export type CanvasNodeType =
  | "objective"
  | "keyResult"
  | "opportunity"
  | "solution"
  | "assumption"
  | "experiment"
  | "roadmapItem";

// Per-type card sizing — must stay roughly in sync with the Tailwind
// dimensions of the corresponding components/canvas/*-node.tsx so ELK's
// spacing decisions match what actually renders. Starting estimates, not
// load-bearing precision.
export const NODE_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  objective: { width: 320, height: 100 },
  keyResult: { width: 280, height: 90 },
  opportunity: { width: 300, height: 90 },
  solution: { width: 280, height: 72 },
  assumption: { width: 280, height: 84 },
  experiment: { width: 300, height: 92 },
  roadmapItem: { width: 260, height: 80 },
};

export interface CanvasPosition {
  x: number;
  y: number;
  pinned: boolean;
}

export interface CanvasLayoutInput {
  id: string;
  type: CanvasNodeType;
  position: CanvasPosition | null;
}

export interface CanvasLayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface LaidOutCanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
}

function isPinned(
  input: CanvasLayoutInput
): input is CanvasLayoutInput & { position: CanvasPosition } {
  return input.position !== null && input.position.pinned;
}

export async function computeCanvasLayout(
  nodes: CanvasLayoutInput[],
  edges: CanvasLayoutEdge[]
): Promise<LaidOutCanvasNode[]> {
  if (nodes.length === 0) return [];

  const children: ElkNode[] = nodes.map((node) => ({
    id: node.id,
    ...NODE_SIZE[node.type],
    ...(isPinned(node) ? { x: node.position.x, y: node.position.y } : {}),
  }));

  const elkEdges: ElkExtendedEdge[] = edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));

  const graph: ElkNode = {
    id: "canvas-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      // Reduces visual fan-out where many RoadmapItems/Opportunities share
      // a common parent.
      "elk.layered.mergeEdges": "true",
      // Bias the algorithm toward preserving the x/y we already supplied for
      // pinned nodes rather than treating every node as free to move.
      "elk.interactive": "true",
    },
    children,
    edges: elkEdges,
  };

  const laidOutGraph = await elk.layout(graph);
  const laidOutById = new Map(
    (laidOutGraph.children ?? []).map((child) => [child.id, child])
  );

  return nodes.map((node) => {
    if (isPinned(node)) {
      return {
        id: node.id,
        type: node.type,
        x: node.position.x,
        y: node.position.y,
      };
    }

    const laidOutChild = laidOutById.get(node.id);
    return {
      id: node.id,
      type: node.type,
      x: laidOutChild?.x ?? 0,
      y: laidOutChild?.y ?? 0,
    };
  });
}

/**
 * Compact "Portfolio" (T0) layout: a tidy grid of just the Objective cards,
 * computed independently of the full ELK graph.
 *
 * Why this exists at all: the ELK layout (computeCanvasLayout above) packs
 * each Objective *together with its whole OST subtree* as a disconnected
 * component and tiles those components across a very large canvas — at a
 * realistic ~30 Objectives the Objective-only bounding box is already
 * ~17,000px wide, so fitting every Objective on screen needs a zoom around
 * 0.03 (unreadable specks). The T0 tier's entire promise is "zoom out and
 * see all your Objectives at once," which the shared ELK coordinates can't
 * deliver. This function gives T0 its own dense grid — Objectives only, no
 * subtree spacing — so they stay readable at a sane zoom regardless of how
 * deep the discovery tree beneath each one is.
 *
 * Pure and deterministic (order in = order out), so it's unit-testable with
 * plain id arrays and carries no React Flow / Prisma dependency, same as the
 * rest of this module.
 *
 * The grid is biased wide (more columns than rows) to match the typical
 * landscape aspect of the canvas pane, so fitView doesn't waste zoom on
 * empty vertical space. `TARGET_ASPECT` is the rough width:height ratio we
 * aim the grid's bounding box at.
 */
const OBJECTIVE_GRID_GAP_X = 80;
const OBJECTIVE_GRID_GAP_Y = 60;
const OBJECTIVE_GRID_TARGET_ASPECT = 2.2;

export interface GridPosition {
  x: number;
  y: number;
}

export function computeObjectiveGridPositions(
  objectiveIds: string[]
): Map<string, GridPosition> {
  const positions = new Map<string, GridPosition>();
  const n = objectiveIds.length;
  if (n === 0) return positions;

  // cols grows sublinearly with n (√n) and is biased wide by the pane
  // aspect. Clamped to [1, n] so a single Objective is one cell and we never
  // ask for more columns than Objectives.
  const cols = Math.min(
    n,
    Math.max(1, Math.round(Math.sqrt(n * OBJECTIVE_GRID_TARGET_ASPECT)))
  );

  const cellW = NODE_SIZE.objective.width + OBJECTIVE_GRID_GAP_X;
  const cellH = NODE_SIZE.objective.height + OBJECTIVE_GRID_GAP_Y;

  objectiveIds.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(id, { x: col * cellW, y: row * cellH });
  });

  return positions;
}
