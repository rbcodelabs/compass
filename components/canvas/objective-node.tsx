"use client";

/**
 * React Flow custom node for an Objective card: title, squad dot,
 * STATUS_BADGE, overall progress, and the embedded KR list (see
 * KeyResultNode) — all inline in the same card. Presentational-only, unlike
 * components/okrs/objective-row.tsx: no useSortable, no inline edit forms,
 * no server-action wiring.
 */
import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ObjectiveStatus, SquadData } from "@/lib/types";
import { averageProgress, STATUS_BADGE } from "@/lib/okrs";
import { KeyResultNode, type CanvasKeyResultData } from "@/components/canvas/key-result-node";

export interface ObjectiveNodeData extends Record<string, unknown> {
  title: string;
  status: ObjectiveStatus;
  squad: SquadData | null;
  keyResults: CanvasKeyResultData[];
}

export type ObjectiveNodeType = Node<ObjectiveNodeData, "objective">;

function ObjectiveNodeComponent({ data }: NodeProps<ObjectiveNodeType>) {
  const avgProgress = averageProgress(data.keyResults);
  const badge = STATUS_BADGE[data.status];

  return (
    <div className="flex w-80 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
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
          <h3 className="font-medium text-sm leading-snug">{data.title}</h3>
        </div>
        <span
          className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Overall progress */}
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

      {/* Embedded KR list */}
      {data.keyResults.length > 0 && (
        <div className="flex flex-col gap-2 pl-2 border-l border-border">
          {data.keyResults.map((kr) => (
            <KeyResultNode key={kr.id} keyResult={kr} />
          ))}
        </div>
      )}
    </div>
  );
}

export const ObjectiveNode = memo(ObjectiveNodeComponent);
