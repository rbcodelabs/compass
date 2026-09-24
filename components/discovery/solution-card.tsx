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
import { SOLUTION_STATUS } from "@/lib/solution-status";
import {
  updateSolutionStatus,
  archiveSolution,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { SolutionStatus } from "@/lib/types";

// Quick-move targets offered from the card menu — KILLED is reached via the
// dedicated destructive "Kill / Archive" action instead, same split
// OpportunityCard uses between STATUS_ORDER moves and its Archive action.
const STATUS_ORDER: SolutionStatus[] = ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED"];

// Badge classes and labels now come from lib/solution-status.ts (used directly
// at the call sites below) so the card, the solution panel, and the opportunity
// panel can't drift apart again. Note this changes the card's IN_DELIVERY label
// from "In Delivery" to "In delivery", matching the panels — which is what the
// e2e specs already assert on.

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
  /**
   * Whether to show the status badge. Defaults to `true` for the Opportunity
   * panel's flat `SolutionsList`, where the badge is the *only* status signal.
   *
   * Boards whose columns already are statuses should pass `false`: the badge
   * is redundant there, and because `EntityCard` lays it out as a `shrink-0`
   * sibling of the `min-w-0 flex-1` title block, it claims fixed width and
   * pushes the title into `line-clamp-2` truncation. `OpportunityCard` avoids
   * this by passing no status at all — same reasoning, same fix.
   */
  showStatus?: boolean;
  onChanged?: () => void;
};

export function SolutionCard({ solution, revalidatePathStr, showStatus = true, onChanged }: Props) {
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
      onChanged?.();
    });
  }

  function handleKill() {
    startTransition(async () => {
      await archiveSolution(solution.id, revalidatePathStr);
      onChanged?.();
    });
  }

  // Both chips self-hide at 0 (EvidenceBadge already returned null there), so
  // with neither to show the row would be empty but still cost EntityCard's
  // `mt-3` children gap. Skip the whole block instead of leaving a blank row.
  const hasMetadata = solution._count.assumptions > 0 || solution._count.evidence > 0;

  return (
    <div ref={setNodeRef} style={style} className="group">
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
          showStatus ? (
            <span
              className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium ${SOLUTION_STATUS[solution.status].className}`}
            >
              {SOLUTION_STATUS[solution.status].label}
            </span>
          ) : undefined
        }
        actions={
          <CardMenu
            items={[
              ...STATUS_ORDER.filter((s) => s !== solution.status).map((s) => ({
                label: `Move to ${SOLUTION_STATUS[s].label}`,
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
        {hasMetadata && (
          <div data-slot="solution-card-meta" className="flex flex-wrap items-center gap-1.5">
            {solution._count.assumptions > 0 && (
              <Badge variant="secondary">
                {solution._count.assumptions} {solution._count.assumptions === 1 ? "assumption" : "assumptions"}
              </Badge>
            )}
            <EvidenceBadge count={solution._count.evidence} />
          </div>
        )}
      </EntityCard>
    </div>
  );
}
