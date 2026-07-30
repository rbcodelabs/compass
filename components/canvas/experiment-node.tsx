"use client";

/**
 * React Flow custom node for an Experiment card: title, squad dot,
 * EXPERIMENT_STATUS_BADGE, plus CONCLUSION_BADGE when a conclusion has been
 * logged. Presentational-only, following the pattern established by
 * objective-node.tsx.
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { FlaskConical } from "lucide-react";
import type { ExperimentStatus, Conclusion, SquadData } from "@/lib/types";
import { EXPERIMENT_STATUS_BADGE, CONCLUSION_BADGE } from "@/lib/discovery";

export interface ExperimentNodeData extends Record<string, unknown> {
  title: string;
  squad: SquadData | null;
  status: ExperimentStatus;
  conclusion: Conclusion | null;
}

export type ExperimentNodeType = Node<ExperimentNodeData, "experiment">;

function ExperimentNodeComponent({ data }: NodeProps<ExperimentNodeType>) {
  const badge = EXPERIMENT_STATUS_BADGE[data.status];
  const conclusionBadge = data.conclusion ? CONCLUSION_BADGE[data.conclusion] : null;

  return (
    <div className="flex w-72 flex-col gap-2 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
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
      <div className="flex items-center gap-1 flex-wrap">
        <span
          className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
        {conclusionBadge && (
          <span
            className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${conclusionBadge.className}`}
          >
            {conclusionBadge.label}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const ExperimentNode = memo(ExperimentNodeComponent);
