"use client";

/**
 * React Flow custom node for a RoadmapItem card: title, squad dot,
 * HORIZON_BADGE pill, red Bug badge when isBug. Terminal node in the graph
 * (a RoadmapItem is always an edge target, never a source) — still gets a
 * source Handle unconditionally per the established convention (simpler
 * than conditional per-type wiring; an unused handle is harmless).
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Bug } from "lucide-react";
import type { Horizon, SquadData } from "@/lib/types";
import { HORIZON_BADGE } from "@/lib/discovery";

export interface RoadmapItemNodeData extends Record<string, unknown> {
  title: string;
  horizon: Horizon;
  squad: SquadData | null;
  isBug: boolean;
}

export type RoadmapItemNodeType = Node<RoadmapItemNodeData, "roadmapItem">;

function RoadmapItemNodeComponent({ data }: NodeProps<RoadmapItemNodeType>) {
  const horizon = HORIZON_BADGE[data.horizon];

  return (
    <div className="flex w-60 flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          {data.squad && (
            <span
              className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: data.squad.color }}
              title={data.squad.name}
            />
          )}
          <h3 className="text-xs font-medium text-slate-800 leading-snug truncate min-w-0 flex-1" title={data.title}>
            {data.title}
          </h3>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <span
          className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-white ${horizon.className}`}
        >
          {horizon.label}
        </span>
        {data.isBug && (
          <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-red-100 px-2 text-[11px] font-medium text-red-600">
            <Bug className="size-3" />
            Bug
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const RoadmapItemNode = memo(RoadmapItemNodeComponent);
