"use client";

/**
 * The <ReactFlow> wrapper for the Canvas viewer — renders the full OST +
 * Roadmap graph in one eager pass (Objective -> KeyResult -> Opportunity ->
 * Solution -> Assumption -> Experiment, plus RoadmapItem), with real edges.
 *
 * Receives fetched overview data as props and computes layout client-side
 * on mount via computeCanvasLayout. `onlyRenderVisibleElements` is enabled
 * by default per the design doc's scale mitigation for large workspaces —
 * not a later optimization. Still a static, view-only graph this phase: no
 * zoom tiers, no lazy per-KR fetch, no drag-to-pin UI.
 */
import { useEffect, useState } from "react";
import { ReactFlow, Background, Controls, MarkerType } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Waypoints } from "lucide-react";
import {
  computeCanvasLayout,
  type CanvasLayoutInput,
  type CanvasNodeType,
} from "@/lib/canvas/layout";
import { buildCanvasEdges } from "@/lib/canvas/edges";
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

export function CanvasFlow({ overview }: CanvasFlowProps) {
  const [nodes, setNodes] = useState<CanvasFlowNode[] | null>(null);
  const [edges, setEdges] = useState<Edge[]>([]);

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

          switch (n.type) {
            case "objective": {
              const obj = objectiveById.get(n.id);
              if (!obj) break;
              computedNodes.push({
                id: n.id,
                type: "objective",
                position,
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

        setNodes(computedNodes);
        setEdges(computedEdges);
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

  if (totalEntityCount === 0) {
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
        edges={edges}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        fitView
        // No drag-to-pin UI yet — nodes render at their computed layout
        // position and stay there. Explicit false avoids React Flow's
        // dev-mode warning about draggable/connectable nodes with no
        // onNodesChange/onConnect handlers.
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
