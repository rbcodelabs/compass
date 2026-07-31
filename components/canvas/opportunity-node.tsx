"use client";

/**
 * React Flow custom node for an Opportunity card: title, squad dot,
 * OPPORTUNITY_STATUS_BADGE. Presentational-only, following the pattern
 * established by objective-node.tsx.
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Lightbulb } from "lucide-react";
import type { OpportunityStatus, SquadData } from "@/lib/types";
import { OPPORTUNITY_STATUS_BADGE } from "@/lib/discovery";

export interface OpportunityNodeData extends Record<string, unknown> {
  title: string;
  status: OpportunityStatus;
  squad: SquadData | null;
}

export type OpportunityNodeType = Node<OpportunityNodeData, "opportunity">;

function OpportunityNodeComponent({ data }: NodeProps<OpportunityNodeType>) {
  const badge = OPPORTUNITY_STATUS_BADGE[data.status];

  return (
    <div className="flex w-72 flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50/70 p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
          {data.squad && (
            <span
              className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: data.squad.color }}
              title={data.squad.name}
            />
          )}
          <h3 className="text-sm font-semibold text-violet-900 leading-snug truncate min-w-0 flex-1" title={data.title}>
            {data.title}
          </h3>
        </div>
        <span
          className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const OpportunityNode = memo(OpportunityNodeComponent);
