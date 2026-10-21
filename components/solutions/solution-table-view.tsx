"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { usePanelContext } from "@/components/panels/panel-context";
import {
  DataGrid,
  type GridBatchResult,
  type GridColumnDef,
  type GridCreation,
  type GridDraftSubmitItem,
  type GridEditOption,
} from "@/components/data-grid";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { ScoreBadge } from "@/components/discovery/score-badge";
import { Badge } from "@/components/ui/badge";
import {
  SOLUTION_DRAFT_TITLE_MAX_LENGTH,
  buildSolutionCreation,
  submitSolutionDrafts,
  useSolutionCreationTerms,
} from "@/components/solutions/solution-creation";
import { savePanelEntityField } from "@/lib/panel-entity-save";
import { SOLUTION_STATUS } from "@/lib/solution-status";
import type { SolutionStatus } from "@/lib/types";
import type { SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";

type Props = {
  /** Already filtered and ordered by the page; the table renders them as given. */
  solutions: SolutionBacklogItem[];
  orgSlug: string;
  workspaceSlug: string;
  /** True when the workspace has an active Solution scoring model. */
  hasActiveScoringModel?: boolean;
  /**
   * Present when the table is interactive: sheet mode (Enter edits the title
   * and status through the panel save path) plus the draft area for adding
   * solutions under a chosen Opportunity. Without it the table is read-only.
   */
  editing?: SolutionTableEditing;
};

export type SolutionTableEditing = {
  /** Every live Opportunity of the workspace: the parents "Add solutions" offers. */
  parents: { id: string; title: string }[];
  /** The workspace context's `isReadOnly`. A UX affordance; the server enforces writes. */
  readOnly: boolean;
};

const STATUS_OPTIONS: readonly GridEditOption[] = (Object.keys(SOLUTION_STATUS) as SolutionStatus[]).map((value) => ({
  value,
  label: SOLUTION_STATUS[value].label,
}));

/**
 * The Solutions backlog as a flat table: one row per Solution across every
 * parent Opportunity. Mirrors components/discovery/discovery-table-view.tsx,
 * minus the expand/collapse tier (there is no nesting here).
 *
 * Column definitions only close over stable values, so a re-render caused by a
 * revalidation updates cells in place instead of remounting them.
 */
export function SolutionTableView({ solutions, orgSlug, workspaceSlug, hasActiveScoringModel = false, editing }: Props) {
  const labels = useLabels();
  const { openPanel } = usePanelContext();
  const interactive = Boolean(editing);
  const readOnly = editing?.readOnly ?? false;

  // The server hands over a fresh parents array on every render; key on content
  // so a revalidation does not rebuild the columns or the creation config.
  const parentsKey = JSON.stringify(editing?.parents ?? []);
  const parents = useMemo(
    () => (JSON.parse(parentsKey) as { id: string; title: string }[]).map((parent) => ({ value: parent.id, label: parent.title })),
    [parentsKey],
  );
  const slugsRef = useRef({ orgSlug, workspaceSlug });
  const parentsRef = useRef(parents);
  useEffect(() => {
    slugsRef.current = { orgSlug, workspaceSlug };
    parentsRef.current = parents;
  }, [orgSlug, workspaceSlug, parents]);

  // A stable callback (refs are read when it is called, never in render), so the column definitions stay stable.
  const saveField = useCallback(
    (id: string, field: string, value: string | null) => savePanelEntityField("solution", slugsRef.current, id, field, value),
    [],
  );
  const submit = useCallback(
    (items: GridDraftSubmitItem[]): Promise<GridBatchResult> => submitSolutionDrafts(slugsRef.current, parentsRef.current, items),
    [],
  );
  const solutionTerms = useSolutionCreationTerms();
  const creation = useMemo<GridCreation | undefined>(
    () =>
      interactive
        ? { ...buildSolutionCreation(parents, solutionTerms), submit }
        : undefined,
    [interactive, parents, solutionTerms, submit],
  );

  const columns = useMemo<GridColumnDef<SolutionBacklogItem>[]>(() => {
    const parentHref = (item: SolutionBacklogItem) => `/${orgSlug}/${workspaceSlug}/discovery/${item.opportunity.id}`;
    const base: GridColumnDef<SolutionBacklogItem>[] = [
      {
        id: "title",
        header: labels.solution.singular,
        meta: {
          label: labels.solution.singular,
          hideable: false,
          minWidth: "16rem",
          ...(interactive
            ? {
                edit: {
                  kind: "text" as const,
                  field: "title" as const,
                  maxLength: SOLUTION_DRAFT_TITLE_MAX_LENGTH,
                  getValue: (row: SolutionBacklogItem) => row.title,
                  parse: (text: string) => {
                    const title = text.trim();
                    if (!title) return { ok: false as const, error: "Title is required" };
                    if (title.length > SOLUTION_DRAFT_TITLE_MAX_LENGTH) {
                      return { ok: false as const, error: `Title must be ${SOLUTION_DRAFT_TITLE_MAX_LENGTH} characters or fewer` };
                    }
                    return { ok: true as const, value: title };
                  },
                  triggerLabel: (row: SolutionBacklogItem) => `Title for ${row.title}`,
                  save: (row: SolutionBacklogItem, next: string | null) =>
                    saveField(row.id, "title", next),
                },
              }
            : {}),
        },
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
        meta: {
          label: "Status",
          width: "8rem",
          ...(interactive
            ? {
                edit: {
                  kind: "select" as const,
                  field: "status" as const,
                  options: STATUS_OPTIONS,
                  getValue: (row: SolutionBacklogItem) => row.status,
                  triggerLabel: (row: SolutionBacklogItem) => `Status for ${row.title}`,
                  // Same endpoint as the panel, so a status change still syncs the roadmap.
                  save: (row: SolutionBacklogItem, next: string) =>
                    saveField(row.id, "status", next),
                },
              }
            : {}),
        },
        cell: ({ row }) => {
          const { label, className } = SOLUTION_STATUS[row.original.status];
          return <span className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium ${className}`}>{label}</span>;
        },
      },
    ];

    const score: GridColumnDef<SolutionBacklogItem> = {
      id: "score",
      header: "Score",
      meta: { label: "Score", width: "8rem" },
      cell: ({ row }) => <ScoreBadge score={row.original.score} scoringHref={parentHref(row.original)} />,
    };

    const tail: GridColumnDef<SolutionBacklogItem>[] = [
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
    ];
    // Assembled in one expression rather than pushed: the lint rule for refs treats a mutated
    // array holding the save callback (which reads a ref when called) as a render-time ref read.
    return [...base, ...(hasActiveScoringModel ? [score] : []), ...tail];
  }, [openPanel, orgSlug, workspaceSlug, labels, hasActiveScoringModel, interactive, saveField]);

  // With the draft area available an empty backlog must still render the grid, or the first solutions could never be added here.
  if (solutions.length === 0 && !(interactive && !readOnly)) {
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
      interaction={interactive ? "sheet" : undefined}
      readOnly={readOnly}
      onOpenRow={interactive ? (row) => openPanel("solution", row.id) : undefined}
      creation={creation}
      className="overflow-hidden rounded-xl border border-border-default bg-surface-panel"
    />
  );
}
