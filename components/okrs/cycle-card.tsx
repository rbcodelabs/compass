import Link from "next/link";
import type { CycleStatus } from "@/lib/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

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

const STATUS_STYLES: Record<CycleStatus, string> = {
  ACTIVE: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  CLOSED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
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
      <Card className="bg-white shadow-sm transition-all duration-150 group-hover:shadow-md group-hover:-translate-y-0.5">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle>{cycle.title}</CardTitle>
            <span
              className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium ${STATUS_STYLES[cycle.status]}`}
            >
              {STATUS_LABELS[cycle.status]}
            </span>
          </div>
          <CardDescription>
            {formatDateRange(cycle.startDate, cycle.endDate)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {cycle._count.objectives === 0
              ? "No objectives yet"
              : `${cycle._count.objectives} objective${cycle._count.objectives === 1 ? "" : "s"}`}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
