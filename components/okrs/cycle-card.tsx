import Link from "next/link";
import type { CycleStatus } from "@/lib/types";
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
  return (
    <Link
      href={`/${orgSlug}/${workspaceSlug}/okrs/${cycle.id}`}
      className="block group"
    >
      <EntityCard interactive className="h-full group-hover:-translate-y-0.5" title={cycle.title} description={formatDateRange(cycle.startDate, cycle.endDate)} status={<StatusBadge status={STATUS_TONE[cycle.status]}>{STATUS_LABELS[cycle.status]}</StatusBadge>}>
        <p className="text-sm text-text-subtle">{cycle._count.objectives === 0 ? "No objectives yet" : `${cycle._count.objectives} objective${cycle._count.objectives === 1 ? "" : "s"}`}</p>
      </EntityCard>
    </Link>
  );
}
