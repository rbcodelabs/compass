"use client";

/**
 * React Flow custom node for a Solution card: title, SOLUTION_STATUS_BADGE.
 * Presentational-only, following the pattern established by
 * objective-node.tsx.
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Layers } from "lucide-react";
import type { SolutionStatus } from "@/lib/types";
import { SOLUTION_STATUS_BADGE } from "@/lib/discovery";

export interface SolutionNodeData extends Record<string, unknown> {
  title: string;
  status: SolutionStatus;
}

export type SolutionNodeType = Node<SolutionNodeData, "solution">;

function SolutionNodeComponent({ data }: NodeProps<SolutionNodeType>) {
  const badge = SOLUTION_STATUS_BADGE[data.status];

  return (
    <div className="flex w-64 items-center gap-2.5 rounded-xl border border-blue-100 bg-blue-50/60 p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <Layers className="size-3.5 shrink-0 text-blue-500" />
      <p className="flex-1 text-xs font-medium text-text-primary leading-snug truncate min-w-0" title={data.title}>
        {data.title}
      </p>
      <span
        className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${badge.className}`}
      >
        {badge.label}
      </span>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const SolutionNode = memo(SolutionNodeComponent);
