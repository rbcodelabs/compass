"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { usePanelContext } from "@/components/panels/panel-context";
import { DataGrid, type GridColumnDef } from "@/components/data-grid";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { ScoreBadge } from "@/components/discovery/score-badge";
import { Badge } from "@/components/ui/badge";
import { SOLUTION_STATUS } from "@/lib/solution-status";
import type { SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";

type Props = {
  /** Already filtered and ordered by the page; the table renders them as given. */
  solutions: SolutionBacklogItem[];
  orgSlug: string;
  workspaceSlug: string;
  /** True when the workspace has an active Solution scoring model. */
  hasActiveScoringModel?: boolean;
};

/**
 * The Solutions backlog as a flat table: one row per Solution across every
 * parent Opportunity. Mirrors components/discovery/discovery-table-view.tsx,
 * minus the expand/collapse tier (there is no nesting here).
 *
 * Column definitions only close over stable values, so a re-render caused by a
 * revalidation updates cells in place instead of remounting them.
 */
export function SolutionTableView({ solutions, orgSlug, workspaceSlug, hasActiveScoringModel = false }: Props) {
  const labels = useLabels();
  const { openPanel } = usePanelContext();

  const columns = useMemo<GridColumnDef<SolutionBacklogItem>[]>(() => {
    const parentHref = (item: SolutionBacklogItem) => `/${orgSlug}/${workspaceSlug}/discovery/${item.opportunity.id}`;
    const base: GridColumnDef<SolutionBacklogItem>[] = [
      {
        id: "title",
        header: labels.solution.singular,
        meta: { label: labels.solution.singular, hideable: false, minWidth: "16rem" },
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => openPanel("solution", row.original.id)}
            className="max-w-md truncate text-left font-medium hover:underline underline-offset-2"
          >
            {row.original.title}
          </button>
        ),
      },
      {
        id: "opportunity",
        header: labels.opportunity.singular,
        meta: { label: labels.opportunity.singular, width: "14rem" },
        cell: ({ row }) => (
          <Link href={parentHref(row.original)} className="block max-w-xs truncate hover:underline underline-offset-2">
            {row.original.opportunity.title}
          </Link>
        ),
      },
      {
        id: "squad",
        header: "Squad",
        meta: { label: "Squad", width: "9rem" },
        cell: ({ row }) => {
          const { squad } = row.original.opportunity;
          if (!squad) return <span className="text-text-subtle">—</span>;
          return (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: squad.color }} />
              <span className="truncate">{squad.name}</span>
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        meta: { label: "Status", width: "8rem" },
        cell: ({ row }) => {
          const { label, className } = SOLUTION_STATUS[row.original.status];
          return <span className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium ${className}`}>{label}</span>;
        },
      },
    ];

    if (hasActiveScoringModel) {
      base.push({
        id: "score",
        header: "Score",
        meta: { label: "Score", width: "8rem" },
        cell: ({ row }) => <ScoreBadge score={row.original.score} scoringHref={parentHref(row.original)} />,
      });
    }

    base.push(
      {
        id: "evidence",
        header: "Evidence",
        meta: { label: "Evidence", width: "8rem" },
        cell: ({ row }) =>
          row.original._count.evidence > 0 ? (
            <EvidenceBadge count={row.original._count.evidence} />
          ) : (
            <span className="text-text-subtle">—</span>
          ),
      },
      {
        id: "assumptions",
        header: "Assumptions",
        meta: { label: "Assumptions", width: "9rem" },
        cell: ({ row }) => {
          const count = row.original._count.assumptions;
          return <Badge variant="secondary">{`${count} ${count === 1 ? "assumption" : "assumptions"}`}</Badge>;
        },
      },
    );
    return base;
  }, [openPanel, orgSlug, workspaceSlug, labels, hasActiveScoringModel]);

  if (solutions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-default px-4 py-12 text-center text-sm text-text-secondary">
        {`No ${labels.solution.lowerPlural} match the current filters.`}
      </div>
    );
  }

  return (
    <DataGrid<SolutionBacklogItem>
      gridId="solutions-table"
      columns={columns}
      rows={solutions}
      getRowId={(row) => row.id}
      caption={`${labels.solution.singular} backlog`}
      height="fill"
      pagination={false}
      toolbar={false}
      className="overflow-hidden rounded-xl border border-border-default bg-surface-panel"
    />
  );
}
