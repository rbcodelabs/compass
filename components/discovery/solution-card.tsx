"use client";

import * as React from "react";
import { useTransition } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EntityCard } from "@/components/patterns/entity-card";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { CardMenu } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import {
  updateSolutionStatus,
  archiveSolution,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { SolutionStatus } from "@/lib/types";

// Quick-move targets offered from the card menu — KILLED is reached via the
// dedicated destructive "Kill / Archive" action instead, same split
// OpportunityCard uses between STATUS_ORDER moves and its Archive action.
const STATUS_ORDER: SolutionStatus[] = ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED"];

const STATUS_BADGE_CLASSES: Record<SolutionStatus, string> = {
  IDEA: "bg-secondary text-secondary-foreground",
  VALIDATED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  IN_DELIVERY: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  SHIPPED: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  KILLED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const STATUS_LABELS: Record<SolutionStatus, string> = {
  IDEA: "Idea",
  VALIDATED: "Validated",
  IN_DELIVERY: "In Delivery",
  SHIPPED: "Shipped",
  KILLED: "Killed",
};

/**
 * Leaner than before: assumptions/comments/evidence are no longer read in
 * full here — everything interactive (assumption management, evidence,
 * Plan & Discussion, Promote to Roadmap) now lives in the Solution sidebar
 * panel (components/panels/solution-panel.tsx), the single place a solution
 * is fully managed from. This card is just a compact, clickable summary row,
 * matching components/discovery/opportunity-card.tsx.
 */
export type SolutionCardData = {
  id: string;
  title: string;
  description: string | null;
  status: SolutionStatus;
  sortOrder: number;
  _count: { assumptions: number; evidence: number };
};

type Props = {
  solution: SolutionCardData;
  revalidatePathStr: string;
};

export function SolutionCard({ solution, revalidatePathStr }: Props) {
  const { openPanel } = usePanelContext();
  const [isPending, startTransition] = useTransition();

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: solution.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function moveStatus(status: SolutionStatus) {
    startTransition(async () => {
      await updateSolutionStatus(solution.id, status, revalidatePathStr);
    });
  }

  function handleKill() {
    startTransition(async () => {
      await archiveSolution(solution.id, revalidatePathStr);
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <EntityCard
        interactive
        title={
          <button
            type="button"
            onClick={() => openPanel("solution", solution.id)}
            className="line-clamp-2 text-left hover:underline underline-offset-2"
          >
            {solution.title}
          </button>
        }
        description={solution.description}
        leading={
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        status={
          <span
            className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium ${STATUS_BADGE_CLASSES[solution.status]}`}
          >
            {STATUS_LABELS[solution.status]}
          </span>
        }
        actions={
          <CardMenu
            items={[
              ...STATUS_ORDER.filter((s) => s !== solution.status).map((s) => ({
                label: `Move to ${STATUS_LABELS[s]}`,
                onClick: () => moveStatus(s),
                disabled: isPending,
              })),
              { label: "Kill / Archive", onClick: () => handleKill(), separator: true, destructive: true },
            ]}
          />
        }
        className="w-full p-3 data-[pending]:opacity-60 data-[dragging=true]:shadow-[var(--shadow-panel)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/30"
        data-pending={isPending ? true : undefined}
        data-dragging={isDragging ? true : undefined}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">
            {solution._count.assumptions} {solution._count.assumptions === 1 ? "assumption" : "assumptions"}
          </Badge>
          <EvidenceBadge count={solution._count.evidence} />
        </div>
      </EntityCard>
    </div>
  );
}
