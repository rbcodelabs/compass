"use client";

import Link from "next/link";
import type { CycleStatus } from "@/lib/types";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { EntityCard } from "@/components/patterns/entity-card";
import { StatusBadge } from "@/components/patterns/status-badge";

interface CycleCardProps {
  cycle: {
    id: string;
    title: string;
    startDate: Date;
    endDate: Date;
    status: CycleStatus;
    _count: { objectives: number };
  };
  orgSlug: string;
  workspaceSlug: string;
}

const STATUS_TONE: Record<CycleStatus, "success" | "neutral"> = {
  ACTIVE: "success", DRAFT: "neutral", CLOSED: "neutral",
};

const STATUS_LABELS: Record<CycleStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  CLOSED: "Closed",
};

function formatDateRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export function CycleCard({ cycle, orgSlug, workspaceSlug }: CycleCardProps) {
  const labels = useLabels();
  return (
    <Link
      href={`/${orgSlug}/${workspaceSlug}/okrs/${cycle.id}`}
      className="block group"
    >
      <EntityCard interactive className="h-full group-hover:-translate-y-0.5" title={cycle.title} description={formatDateRange(cycle.startDate, cycle.endDate)} status={<StatusBadge status={STATUS_TONE[cycle.status]}>{STATUS_LABELS[cycle.status]}</StatusBadge>}>
        <p className="text-sm text-text-subtle">{cycle._count.objectives === 0 ? `No ${labels.objective.lowerPlural} yet` : `${cycle._count.objectives} ${cycle._count.objectives === 1 ? labels.objective.lower : labels.objective.lowerPlural}`}</p>
      </EntityCard>
    </Link>
  );
}
