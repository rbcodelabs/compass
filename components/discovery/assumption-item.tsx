"use client";

import * as React from "react";
import { useTransition } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardMenu } from "@/components/ui/card-menu";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import {
  updateAssumptionStatus,
  deleteAssumption,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { AssumptionStatus, RiskLevel } from "@/lib/types";

const RISK_CLASSES: Record<RiskLevel, string> = {
  HIGH: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  MEDIUM: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  LOW: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const STATUS_LABELS: Record<AssumptionStatus, string> = {
  UNTESTED: "Untested",
  TESTING: "Testing",
  VALIDATED: "Validated",
  INVALIDATED: "Invalidated",
};

const STATUS_CLASSES: Record<AssumptionStatus, string> = {
  UNTESTED: "bg-secondary text-secondary-foreground",
  TESTING: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  VALIDATED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  INVALIDATED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const STATUS_CYCLE: AssumptionStatus[] = [
  "UNTESTED",
  "TESTING",
  "VALIDATED",
  "INVALIDATED",
];

export type AssumptionItemData = {
  id: string;
  title: string;
  riskLevel: RiskLevel;
  status: AssumptionStatus;
  sortOrder: number;
  experiments: { id: string }[];
  _count?: { evidence: number };
};

type Props = {
  assumption: AssumptionItemData;
  revalidatePathStr: string;
  workspaceId: string;
};

export function AssumptionItem({ assumption, revalidatePathStr, workspaceId }: Props) {
  const [isPending, startTransition] = useTransition();
  const currentIndex = STATUS_CYCLE.indexOf(assumption.status);
  const nextStatus = STATUS_CYCLE[(currentIndex + 1) % STATUS_CYCLE.length];

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: assumption.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function advanceStatus() {
    startTransition(async () => {
      await updateAssumptionStatus(assumption.id, nextStatus, revalidatePathStr);
    });
  }

  function handleDelete() {
    startTransition(async () => {
      await deleteAssumption(assumption.id, revalidatePathStr);
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-start gap-2 py-1.5 opacity-100 transition-opacity data-[pending]:opacity-50 group touch-none"
      data-pending={isPending ? true : undefined}
    >
      {/* Drag handle */}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none rounded"
        aria-label="Drag to reorder"
      >
        <GripVertical className="size-3.5" />
      </button>

      <span className="flex-1 text-sm leading-snug">{assumption.title}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {!!assumption._count?.evidence && (
          <span className="inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium bg-secondary text-secondary-foreground">
            {assumption._count.evidence} {assumption._count.evidence === 1 ? "signal" : "signals"}
          </span>
        )}
        <span
          className={`inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium ${RISK_CLASSES[assumption.riskLevel]}`}
        >
          {assumption.riskLevel}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={isPending}
          onClick={advanceStatus}
          className={`h-5 px-2 text-xs font-medium rounded-4xl border-0 ${STATUS_CLASSES[assumption.status]}`}
          title={`Advance to ${STATUS_LABELS[nextStatus]}`}
        >
          {STATUS_LABELS[assumption.status]}
        </Button>
        <AddEvidenceDialog
          workspaceId={workspaceId}
          nodeType="assumption"
          nodeId={assumption.id}
          revalidatePathStr={revalidatePathStr}
          compact
        />
        <CardMenu
          items={[
            {
              label: "Delete",
              onClick: () => handleDelete(),
              destructive: true,
            },
          ]}
        />
      </div>
    </div>
  );
}
