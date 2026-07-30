"use client";

/**
 * React Flow custom node for an Objective card: title, squad dot,
 * STATUS_BADGE, and an aggregate progress bar only. KeyResult is now its
 * own first-class node type (see key-result-node.tsx) connected by a real
 * edge, so this card is a fixed-height shell with no embedded KR list and
 * no variable-height sizing logic. Presentational-only, unlike
 * components/okrs/objective-row.tsx: no useSortable, no inline edit forms,
 * no server-action wiring.
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ObjectiveStatus, SquadData } from "@/lib/types";
import { averageProgress, STATUS_BADGE } from "@/lib/okrs";

export interface ObjectiveNodeData extends Record<string, unknown> {
  title: string;
  status: ObjectiveStatus;
  squad: SquadData | null;
  /** Just enough of each Key Result to average progress — the KRs
   * themselves render as separate connected nodes now. */
  keyResults: { current: number; target: number }[];
}

export type ObjectiveNodeType = Node<ObjectiveNodeData, "objective">;

function ObjectiveNodeComponent({ data }: NodeProps<ObjectiveNodeType>) {
  const avgProgress = averageProgress(data.keyResults);
  const badge = STATUS_BADGE[data.status];

  return (
    <div className="flex w-80 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          {data.squad && (
            <span
              className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: data.squad.color }}
              title={data.squad.name}
            />
          )}
          {/* Truncated to a single line, not wrapped: computeCanvasLayout
              estimates each card's height from a fixed NODE_SIZE (see
              lib/canvas/layout.ts) assuming a one-line title. A wrapped
              multi-line title would grow taller than that estimate and
              visually overlap the next row's cards. */}
          <h3 className="font-medium text-sm leading-snug truncate min-w-0 flex-1" title={data.title}>
            {data.title}
          </h3>
        </div>
        <span
          className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Aggregate progress across this Objective's Key Results */}
      {data.keyResults.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary/60"
              style={{ width: `${avgProgress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {avgProgress}%
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const ObjectiveNode = memo(ObjectiveNodeComponent);
