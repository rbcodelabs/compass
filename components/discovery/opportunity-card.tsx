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
  updateOpportunityStatus,
  archiveOpportunity,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus } from "@/lib/types";

const STATUS_ORDER: OpportunityStatus[] = [
  "EXPLORING",
  "VALIDATING",
  "PRIORITIZED",
  "ACTIVE",
];

const STATUS_LABELS: Record<OpportunityStatus, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

export type OpportunityCardData = {
  id: string;
  title: string;
  customerSegment: string | null;
  status: OpportunityStatus;
  sortOrder: number;
  _count: { solutions: number; evidence: number };
  evidenceSourceCount?: number;
  squad?: { id: string; name: string; color: string } | null;
};

type Props = {
  opportunity: OpportunityCardData;
  orgSlug: string;
  workspaceSlug: string;
};

export function OpportunityCard({ opportunity, orgSlug, workspaceSlug }: Props) {
  const [isPending, startTransition] = useTransition();
  const { openPanel } = usePanelContext();

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: opportunity.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;

  function moveStatus(status: OpportunityStatus) {
    startTransition(async () => {
      await updateOpportunityStatus(opportunity.id, status, boardPath);
    });
  }

  function handleArchive() {
    startTransition(async () => {
      await archiveOpportunity(opportunity.id, boardPath);
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <EntityCard
        interactive
        title={
          <button
            type="button"
            onClick={() => openPanel("opportunity", opportunity.id)}
            className="line-clamp-2 text-left hover:underline underline-offset-2"
          >
            {opportunity.title}
          </button>
        }
        description={opportunity.customerSegment}
        leading={
          <div className="flex items-center gap-1.5">
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
              aria-label="Drag to reorder"
            >
              <GripVertical className="size-3.5" />
            </button>
            {opportunity.squad && (
              <span
                className="size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: opportunity.squad.color }}
                title={opportunity.squad.name}
              />
            )}
          </div>
        }
        actions={
          <CardMenu
            items={[
              ...STATUS_ORDER.filter((s) => s !== opportunity.status).map((s) => ({
                label: `Move to ${STATUS_LABELS[s]}`,
                onClick: () => moveStatus(s),
                disabled: isPending,
              })),
              { label: "Archive", onClick: () => handleArchive(), separator: true, destructive: true },
            ]}
          />
        }
        className="w-full p-3 data-[pending]:opacity-60 data-[dragging=true]:shadow-[var(--shadow-panel)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/30"
        data-pending={isPending ? true : undefined}
        data-dragging={isDragging ? true : undefined}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{opportunity._count.solutions} {opportunity._count.solutions === 1 ? "solution" : "solutions"}</Badge>
          <EvidenceBadge count={opportunity._count.evidence} sourceCount={opportunity.evidenceSourceCount} />
        </div>
      </EntityCard>
    </div>
  );
}
