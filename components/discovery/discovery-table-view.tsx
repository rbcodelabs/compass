"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type GridColumnDef } from "@/components/data-grid";
import { OPPORTUNITY_STATUS_BADGE } from "@/lib/discovery";
import { SOLUTION_STATUS } from "@/lib/solution-status";
import type { OpportunityStatus, SolutionStatus } from "@/lib/types";

export type DiscoveryTableSolution = {
  id: string;
  title: string;
  status: SolutionStatus;
  sortOrder: number;
  evidenceCount: number;
  assumptionCount: number;
};

export type DiscoveryTableOpportunity = {
  id: string;
  title: string;
  customerSegment: string | null;
  status: OpportunityStatus;
  sortOrder: number;
  squad: { id: string; name: string; color: string } | null;
  evidenceCount: number;
  solutions: DiscoveryTableSolution[];
};

/**
 * One flattened row. Discovery is a two-level disclosure, and the grid
 * registers none of TanStack's row models by design (every engine is
 * server-owned), so expansion is flattened client-side the way the task list
 * already flattens its hierarchy rather than pulling in `rowExpandingFeature`
 * for a single screen.
 *
 * `isExpanded` rides on the ROW rather than being read from a closure inside
 * the cell renderer, and that is load-bearing. `table.FlexRender` unmounts and
 * remounts a cell's whole subtree whenever the column definition's identity
 * changes (verified directly against 9.1.2). A column that closed over
 * `expandedIds` would therefore be rebuilt on every toggle and tear down the
 * disclosure button the user just activated, losing keyboard focus. Column
 * definitions stay referentially stable; everything that varies is data.
 */
type DiscoveryGridRow =
  | {
      rowKey: string;
      kind: "opportunity";
      opportunity: DiscoveryTableOpportunity;
      isExpanded: boolean;
    }
  | { rowKey: string; kind: "solution"; parentId: string; solution: DiscoveryTableSolution };

function StatusBadge({ label, className }: { label: string; className: string }) {
  return <span className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium ${className}`}>{label}</span>;
}

function countLabel(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function DiscoveryTableView({ opportunities }: { opportunities: DiscoveryTableOpportunity[] }) {
  const { openPanel } = usePanelContext();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Stable identity (a functional setState needs no dependencies), so the
  // column definitions that close over it never have to be rebuilt.
  const toggleOpportunity = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const rows = useMemo<DiscoveryGridRow[]>(
    () =>
      opportunities.flatMap((opportunity) => {
        const isExpanded = expandedIds.has(opportunity.id);
        const head: DiscoveryGridRow = {
          // Prefixed rather than the bare id, so an opportunity and a solution
          // can never collide in the table's row map.
          rowKey: `opportunity:${opportunity.id}`,
          kind: "opportunity",
          opportunity,
          isExpanded,
        };
        if (!isExpanded) return [head];
        return [
          head,
          ...opportunity.solutions.map((solution): DiscoveryGridRow => ({
            rowKey: `solution:${solution.id}`,
            kind: "solution",
            parentId: opportunity.id,
            solution,
          })),
        ];
      }),
    [opportunities, expandedIds],
  );

  // Columns stay in this file rather than a sibling `*-columns` module:
  // `scripts/check-ui-colors.mjs` keys its baseline on `file::class`, so
  // relocating markup starts it at a baseline of zero.
  const columns = useMemo<GridColumnDef<DiscoveryGridRow>[]>(
    () => [
      {
        id: "item",
        header: "Item",
        // No width — this column absorbs the remainder under `table-fixed`.
        // `hideable: false` pins it first and keeps it out of the column menu.
        //
        // `minWidth` restores the `min-w-72` this table carried before it moved
        // to the grid: without a floor "the remainder" goes negative once the
        // other columns (44rem) out-sum the container and the title collapses.
        // The cell also leads with a 24px expand chevron plus a 6px gap, so
        // 18rem leaves ~258px for the opportunity title itself.
        meta: { label: "Item", hideable: false, minWidth: "18rem" },
        cell: ({ row }) => {
          const data = row.original;
          if (data.kind === "solution") {
            return (
              // The old markup indented the `<td>` itself with `pl-12`. The
              // grid's TableCell keeps its own padding, so the indent moves to
              // an inner element and lands at the same total inset.
              <div className="pl-10">
                <button
                  type="button"
                  onClick={() => openPanel("solution", data.solution.id)}
                  className="max-w-md truncate text-left hover:underline underline-offset-2"
                >
                  {data.solution.title}
                </button>
              </div>
            );
          }
          const { opportunity, isExpanded } = data;
          return (
            <div className="flex items-center gap-1.5">
              {opportunity.solutions.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${opportunity.title}`}
                  aria-expanded={isExpanded}
                  onClick={() => toggleOpportunity(opportunity.id)}
                >
                  <ChevronRight className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                </Button>
              ) : (
                <span className="size-6" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => openPanel("opportunity", opportunity.id)}
                className="max-w-md truncate text-left font-medium hover:underline underline-offset-2"
              >
                {opportunity.title}
              </button>
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        meta: { label: "Status", width: "8rem" },
        cell: ({ row }) => {
          const data = row.original;
          return data.kind === "solution" ? (
            <StatusBadge {...SOLUTION_STATUS[data.solution.status]} />
          ) : (
            <StatusBadge {...OPPORTUNITY_STATUS_BADGE[data.opportunity.status]} />
          );
        },
      },
      {
        id: "squad",
        header: "Squad",
        meta: { label: "Squad", width: "9rem" },
        cell: ({ row }) => {
          const data = row.original;
          // A solution inherits its parent's squad, so the cell is a dash
          // rather than a repeat of the row above.
          if (data.kind === "solution") return <span className="text-text-subtle">—</span>;
          const { squad } = data.opportunity;
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
        id: "segment",
        header: "Customer segment",
        meta: { label: "Customer segment", width: "10rem" },
        cell: ({ row }) => {
          const data = row.original;
          if (data.kind === "solution") return <span className="text-text-subtle">—</span>;
          return data.opportunity.customerSegment ?? <span className="text-text-subtle">—</span>;
        },
      },
      {
        id: "evidence",
        header: "Evidence",
        meta: { label: "Evidence", width: "8rem" },
        cell: ({ row }) => {
          const data = row.original;
          return (
            <EvidenceBadge
              count={data.kind === "solution" ? data.solution.evidenceCount : data.opportunity.evidenceCount}
            />
          );
        },
      },
      {
        id: "details",
        header: "Details",
        meta: { label: "Details", width: "9rem" },
        cell: ({ row }) => {
          const data = row.original;
          return (
            <Badge variant="secondary">
              {data.kind === "solution"
                ? countLabel(data.solution.assumptionCount, "assumption")
                : countLabel(data.opportunity.solutions.length, "solution")}
            </Badge>
          );
        },
      },
    ],
    // Both dependencies are stable across a toggle, so expanding a row updates
    // the affected cells in place instead of remounting every cell in the
    // table — see the note on `DiscoveryGridRow.isExpanded`.
    [openPanel, toggleOpportunity],
  );

  // The "no opportunities at all" case keeps its own dashed box instead of the
  // grid's `emptyState`, which would nest it inside the grid's panel chrome.
  if (opportunities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-default px-4 py-12 text-center text-sm text-text-secondary">
        No opportunities match the current filters.
      </div>
    );
  }

  return (
    // Panel chrome lives on the grid root, not on a scrolling wrapper: the
    // scroll viewport is the grid's own `table-container`, so the border stays
    // put while the rows and the sticky header move inside it.
    //
    // `caption` is the table's accessible name (DataGrid renders it as an
    // sr-only `<caption>`, which IS the accname for role=table). The wording is
    // asserted by e2e/functional/specs/discovery-table.spec.ts.
    <DataGrid<DiscoveryGridRow>
      gridId="discovery-table"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.rowKey}
      caption="Discovery opportunities"
      height="fill"
      pagination={false}
      toolbar={false}
      rowClassName={(row) => (row.kind === "solution" ? "bg-surface-inset/50" : undefined)}
      className="overflow-hidden rounded-xl border border-border-default bg-surface-panel"
    />
  );
}
