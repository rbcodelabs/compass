/**
 * Pin-aware ELK layout wrapper for the Canvas viewer's Objective tier (T1).
 *
 * Pure data in/out — no Prisma, no React Flow types — so it's fully
 * unit-testable without mocking anything. Scoped to Objectives only for
 * Phase 1; Phase 2 will generalize this to the other entity tiers.
 *
 * Every Objective is partitioned into pinned (a user has explicitly saved a
 * {x,y} for it — Phase 1's CanvasNodePosition table is always empty, but the
 * partition exists now so Phase 2's drag-to-pin doesn't need to touch this
 * function's core logic) vs. unpinned (ELK computes placement). Pinned nodes
 * are still handed to ELK — with their saved position and
 * `elk.interactive: true` — so the unpinned layout can account for them, but
 * the *returned* coordinates for a pinned node are always its saved {x,y}
 * verbatim, never whatever ELK nudges it to.
 */
import ElkConstructor from "elkjs/lib/elk-api";
import type { ElkNode } from "elkjs/lib/elk-api";

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

// Objective card sizing — must stay roughly in sync with the Tailwind
// dimensions of components/canvas/objective-node.tsx so ELK's spacing
// decisions match what actually renders.
const NODE_WIDTH = 320;
const BASE_NODE_HEIGHT = 88; // title + squad dot + status badge + progress bar
const KEY_RESULT_ROW_HEIGHT = 30;
const MIN_NODE_HEIGHT = 120;

export interface CanvasPosition {
  x: number;
  y: number;
  pinned: boolean;
}

export interface ObjectiveLayoutInput {
  id: string;
  title: string;
  keyResults: {
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
  }[];
  position: CanvasPosition | null;
}

export interface LaidOutObjectiveNode {
  id: string;
  x: number;
  y: number;
  data: Omit<ObjectiveLayoutInput, "position">;
}

function estimatedNodeHeight(keyResultCount: number): number {
  return Math.max(
    MIN_NODE_HEIGHT,
    BASE_NODE_HEIGHT + keyResultCount * KEY_RESULT_ROW_HEIGHT
  );
}

function isPinned(
  input: ObjectiveLayoutInput
): input is ObjectiveLayoutInput & { position: CanvasPosition } {
  return input.position !== null && input.position.pinned;
}

export async function computeObjectiveLayout(
  objectives: ObjectiveLayoutInput[]
): Promise<LaidOutObjectiveNode[]> {
  if (objectives.length === 0) return [];

  const children: ElkNode[] = objectives.map((obj) => ({
    id: obj.id,
    width: NODE_WIDTH,
    height: estimatedNodeHeight(obj.keyResults.length),
    ...(isPinned(obj) ? { x: obj.position.x, y: obj.position.y } : {}),
  }));

  const graph: ElkNode = {
    id: "canvas-objectives-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      // Bias the algorithm toward preserving the x/y we already supplied for
      // pinned nodes rather than treating every node as free to move.
      "elk.interactive": "true",
    },
    children,
    edges: [],
  };

  const laidOutGraph = await elk.layout(graph);
  const laidOutById = new Map(
    (laidOutGraph.children ?? []).map((child) => [child.id, child])
  );

  return objectives.map((obj) => {
    const { position: _position, ...data } = obj;

    if (isPinned(obj)) {
      return { id: obj.id, x: obj.position.x, y: obj.position.y, data };
    }

    const laidOutChild = laidOutById.get(obj.id);
    return {
      id: obj.id,
      x: laidOutChild?.x ?? 0,
      y: laidOutChild?.y ?? 0,
      data,
    };
  });
}
