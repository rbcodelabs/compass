"use client";

/**
 * React Flow custom node for an Assumption card: title, risk-colored icon,
 * ASSUMPTION_STATUS_BADGE. Presentational-only, following the pattern
 * established by objective-node.tsx.
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import type { AssumptionStatus, RiskLevel } from "@/lib/types";
import { ASSUMPTION_STATUS_BADGE, RISK_LEVEL_BADGE } from "@/lib/discovery";

export interface AssumptionNodeData extends Record<string, unknown> {
  title: string;
  riskLevel: RiskLevel;
  status: AssumptionStatus;
}

export type AssumptionNodeType = Node<AssumptionNodeData, "assumption">;

function AssumptionNodeComponent({ data }: NodeProps<AssumptionNodeType>) {
  const badge = ASSUMPTION_STATUS_BADGE[data.status];
  const risk = RISK_LEVEL_BADGE[data.riskLevel];

  return (
    <div className="flex w-64 flex-col gap-2 rounded-xl border border-amber-100 bg-amber-50/60 p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex items-start gap-2">
        <AlertTriangle className={`mt-0.5 size-3.5 shrink-0 ${risk.className}`} />
        <p className="flex-1 text-xs font-medium text-text-primary leading-snug truncate min-w-0" title={data.title}>
          {data.title}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <span className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium bg-transparent border border-current/20 ${risk.className}`}>
          {data.riskLevel.toLowerCase()}
        </span>
        <span
          className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

export const AssumptionNode = memo(AssumptionNodeComponent);
