"use client";

import * as React from "react";
import { useTransition } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { CardMenu } from "@/components/ui/card-menu";
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

  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunity.id}`;
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
      <Card
        size="sm"
        className="w-full bg-white shadow-sm transition-all duration-150 hover:shadow-md data-[pending]:opacity-60 data-[dragging=true]:shadow-xl data-[dragging=true]:ring-2 data-[dragging=true]:ring-indigo-200"
        data-pending={isPending ? true : undefined}
        data-dragging={isDragging ? true : undefined}
      >
        <CardHeader>
          <div className="flex items-start gap-2">
            {/* Drag handle */}
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              aria-label="Drag to reorder"
            >
              <GripVertical className="size-3.5" />
            </button>

            {opportunity.squad && (
              <span
                className="mt-0.5 w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: opportunity.squad.color }}
                title={opportunity.squad.name}
              />
            )}
            <CardTitle className="flex-1">
              <Link
                href={detailPath}
                className="hover:underline underline-offset-2 line-clamp-2"
              >
                {opportunity.title}
              </Link>
            </CardTitle>
            <CardMenu
              items={[
                ...STATUS_ORDER.filter((s) => s !== opportunity.status).map((s) => ({
                  label: `Move to ${STATUS_LABELS[s]}`,
                  onClick: () => moveStatus(s),
                  disabled: isPending,
                })),
                {
                  label: "Archive",
                  onClick: () => handleArchive(),
                  separator: true,
                  destructive: true,
                },
              ]}
            />
          </div>
          {opportunity.customerSegment && (
            <p className="text-xs text-muted-foreground truncate ml-5">
              {opportunity.customerSegment}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">
              {opportunity._count.solutions}{" "}
              {opportunity._count.solutions === 1 ? "solution" : "solutions"}
            </Badge>
            <EvidenceBadge
              count={opportunity._count.evidence}
              sourceCount={opportunity.evidenceSourceCount}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
