"use client";

/**
 * The <ReactFlow> wrapper for the Canvas viewer (Phase 1: Objective tier
 * only, no cross-Objective edges — see the Canvas Phase 1 plan's Step 5).
 *
 * Receives fetched overview data as props and computes layout client-side
 * on mount via computeObjectiveLayout. `onlyRenderVisibleElements` is
 * enabled by default per the design doc's scale mitigation for workspaces
 * with hundreds of Objectives — not a later optimization.
 */
import { useEffect, useState } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Waypoints } from "lucide-react";
import {
  computeObjectiveLayout,
  type ObjectiveLayoutInput,
} from "@/lib/canvas/layout";
import {
  ObjectiveNode,
  type ObjectiveNodeType,
} from "@/components/canvas/objective-node";
import type { CanvasObjective } from "@/lib/canvas/data";

const nodeTypes = { objective: ObjectiveNode };

interface CanvasFlowProps {
  objectives: CanvasObjective[];
}

export function CanvasFlow({ objectives }: CanvasFlowProps) {
  const [nodes, setNodes] = useState<ObjectiveNodeType[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    const layoutInputs: ObjectiveLayoutInput[] = objectives.map((obj) => ({
      id: obj.id,
      title: obj.title,
      keyResults: obj.keyResults,
      position: obj.position,
    }));

    computeObjectiveLayout(layoutInputs)
      .then((laidOut) => {
        if (cancelled) return;
        const byId = new Map(objectives.map((obj) => [obj.id, obj]));
        const computedNodes: ObjectiveNodeType[] = laidOut.map((n) => {
          const obj = byId.get(n.id);
          return {
            id: n.id,
            type: "objective",
            position: { x: n.x, y: n.y },
            data: {
              title: obj?.title ?? n.data.title,
              status: obj?.status ?? "ON_TRACK",
              squad: obj?.squad ?? null,
              keyResults: obj?.keyResults ?? n.data.keyResults,
            },
          };
        });
        setNodes(computedNodes);
      })
      .catch((err) => {
        // Layout is a pure client-side computation with no network I/O of
        // its own; a rejection here means a real bug (e.g. a malformed
        // input), not a transient failure worth retrying silently.
        console.error("[canvas] failed to compute Objective layout:", err);
        if (!cancelled) setNodes([]);
      });

    return () => {
      cancelled = true;
    };
  }, [objectives]);

  if (objectives.length === 0) {
    return (
      <div className="flex w-full h-full flex-col items-center justify-center gap-4 text-center">
        <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
          <Waypoints className="w-7 h-7 text-slate-400" />
        </div>
        <div>
          <p className="font-semibold text-slate-800">Nothing to show yet</p>
          <p className="text-sm text-slate-500 mt-1 max-w-xs mx-auto">
            Add Objectives and Key Results from the OKRs page to see them
            here.
          </p>
        </div>
      </div>
    );
  }

  if (nodes === null) {
    return (
      <div className="flex w-full h-full items-center justify-center text-sm text-muted-foreground">
        Laying out canvas…
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        fitView
        // No drag-to-pin UI yet (Phase 2) — nodes render at their computed
        // layout position and stay there. Explicit false avoids React Flow's
        // dev-mode warning about draggable nodes with no onNodesChange.
        nodesDraggable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
