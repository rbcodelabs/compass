"use client";

/**
 * React Flow custom node for a Key Result card: title + current/target
 * progress bar. Promoted from an embedded row inside ObjectiveNode (Phase 1)
 * to its own first-class node type, because Opportunity.linkedKeyResultId
 * needs a real edge *target* and an embedded row has no stable per-row
 * Handle to anchor an edge to. Keeps the exact progress-bar/title/
 * current-target markup from the embedded version — e2e already asserts
 * the "0 % / 100 %" text format.
 *
 * Presentational-only, like every other components/canvas/*-node.tsx: no
 * drag handle, no check-in form, no delete menu.
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { TrendingUp } from "lucide-react";
import { clampProgress } from "@/lib/okrs";

export interface CanvasKeyResultData extends Record<string, unknown> {
  title: string;
  current: number;
  target: number;
  unit: string | null;
}

export type KeyResultNodeType = Node<CanvasKeyResultData, "keyResult">;

function KeyResultNodeComponent({ data }: NodeProps<KeyResultNodeType>) {
  const progress = clampProgress(data.current, data.target);
  const unit = data.unit ? ` ${data.unit}` : "";

  return (
    <div className="flex w-64 flex-col gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex items-start gap-2">
        <TrendingUp className="mt-0.5 size-3.5 shrink-0 text-indigo-500" />
        <span className="text-xs font-medium text-slate-800 leading-snug truncate min-w-0 flex-1" title={data.title}>
          {data.title}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>
          {data.current}
          {unit} / {data.target}
          {unit}
        </span>
        <span>{progress}%</span>
      </div>
      <div className="h-1 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-indigo-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const KeyResultNode = memo(KeyResultNodeComponent);
