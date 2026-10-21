"use client";

import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  type GridActionResult,
  type GridBatchResult,
  type GridCellValue,
  type GridColumnDef,
  type GridCreation,
  type GridCreationMode,
  type GridCreationRequest,
  type GridDraftSubmitItem,
  type GridDraftValues,
  type GridEditOption,
} from "@/components/data-grid";
import { buildSolutionCreation, submitSolutionDrafts, useSolutionCreationTerms } from "@/components/solutions/solution-creation";
import { savePanelEntityField } from "@/lib/panel-entity-save";
import { createOpportunitiesBatch } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { BATCH_DESCRIPTION_MAX_LENGTH, BATCH_MAX_ITEMS, BATCH_REQUEST_MAX_BYTES } from "@/lib/batch-create-limits";
import { OPPORTUNITY_STATUS_BADGE } from "@/lib/discovery";
import {
  NEW_OPPORTUNITY_STATUSES,
  OPPORTUNITY_SEGMENT_MAX_LENGTH,
  OPPORTUNITY_TITLE_MAX_LENGTH,
} from "@/lib/opportunity-draft";
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
  /** Shown (and editable) as a column only in the interactive table. */
  description?: string | null;
  status: OpportunityStatus;
  sortOrder: number;
  squad: { id: string; name: string; color: string } | null;
  evidenceCount: number;
  solutions: DiscoveryTableSolution[];
};

/**
 * Present when the table is interactive: the grid then runs in sheet mode
 * (Enter edits, Alt+Enter opens the panel) and offers the draft-row area.
 * Without it the table is the read-only view it always was.
 */
export type DiscoveryTableWorkspace = {
  orgSlug: string;
  workspaceSlug: string;
  squads: { id: string; name: string; color: string }[];
  /**
   * Every live Opportunity of the workspace, offered as the parent in "Add
   * solutions" (the table's own rows are filtered). Falls back to the rows.
   */
  solutionParents?: { id: string; title: string }[];
  /** The workspace context's `isReadOnly`. A UX affordance; the server enforces writes. */
  readOnly: boolean;
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

function countLabel(count: number, singular: string, plural: string = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Squad editor sentinel: select options need a non-empty value. */
const NO_SQUAD = "__none";

const STATUS_OPTIONS: readonly GridEditOption[] = NEW_OPPORTUNITY_STATUSES.map((value) => ({
  value,
  label: OPPORTUNITY_STATUS_BADGE[value].label,
}));

const saveOpportunityField = (
  slugs: { orgSlug: string; workspaceSlug: string },
  opportunityId: string,
  field: string,
  value: GridCellValue,
): Promise<GridActionResult> => savePanelEntityField("opportunity", slugs, opportunityId, field, value);

/** Server field names (OpportunityBatchItem) to draft field ids, so a server field error lands on its cell. */
const DRAFT_FIELD_BY_SERVER_FIELD: Record<string, string> = {
  title: "title",
  description: "description",
  customerSegment: "segment",
  status: "status",
  squadId: "squad",
};

/** Draft values to the server's item shape. Blank optional cells become null. */
export function toOpportunityBatchItem({ clientId, values }: GridDraftSubmitItem) {
  return {
    clientId,
    title: values.title ?? "",
    customerSegment: values.segment?.trim() || null,
    status: values.status || undefined,
    squadId: values.squad || null,
    description: values.description?.trim() || null,
  };
}

/**
 * The draft-area config for Opportunities ("Add opportunities" mode; see
 * components/solutions/solution-creation.ts for the other). The caller adds `submit`, so this stays free of the server action.
 */
export function buildOpportunityCreation(
  squads: readonly { id: string; name: string }[],
  noun: { singular: string; plural: string },
): Omit<GridCreation, "submit"> {
  const squadOptions: GridEditOption[] = [
    { value: "", label: "No squad" },
    ...squads.map((squad) => ({ value: squad.id, label: squad.name })),
  ];
  return {
    fields: [
      { id: "title", label: "Title", kind: "text", maxLength: OPPORTUNITY_TITLE_MAX_LENGTH },
      { id: "segment", label: "Customer segment", kind: "text", maxLength: OPPORTUNITY_SEGMENT_MAX_LENGTH, width: "10rem" },
      { id: "status", label: "Status", kind: "select", options: STATUS_OPTIONS, width: "9rem" },
      { id: "squad", label: "Squad", kind: "select", options: squadOptions, width: "9rem" },
      { id: "description", label: "Description", kind: "text", maxLength: BATCH_DESCRIPTION_MAX_LENGTH },
    ],
    makeValues: (): GridDraftValues => ({ title: "", segment: "", status: "EXPLORING", squad: "", description: "" }),
    validate: (values) => {
      const errors: Record<string, string> = {};
      const title = (values.title ?? "").trim();
      if (!title) errors.title = "Add a title.";
      else if (title.length > OPPORTUNITY_TITLE_MAX_LENGTH) errors.title = `Title must be ${OPPORTUNITY_TITLE_MAX_LENGTH} characters or fewer.`;
      if ((values.segment ?? "").trim().length > OPPORTUNITY_SEGMENT_MAX_LENGTH) {
        errors.segment = `Segment must be ${OPPORTUNITY_SEGMENT_MAX_LENGTH} characters or fewer.`;
      }
      if (!(NEW_OPPORTUNITY_STATUSES as readonly string[]).includes(values.status ?? "")) errors.status = "Choose a valid status.";
      if (values.squad && !squads.some((squad) => squad.id === values.squad)) errors.squad = "Choose one of this workspace's squads.";
      if ((values.description ?? "").trim().length > BATCH_DESCRIPTION_MAX_LENGTH) {
        errors.description = `Description must be ${BATCH_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
      }
      return errors;
    },
    limits: { maxItems: BATCH_MAX_ITEMS.human, maxBytes: BATCH_REQUEST_MAX_BYTES },
    maxRows: 200,
    noun,
    addLabel: `Add ${noun.singular}...`,
  };
}

export function DiscoveryTableView({
  opportunities,
  workspace,
}: {
  opportunities: DiscoveryTableOpportunity[];
  workspace?: DiscoveryTableWorkspace;
}) {
  const labels = useLabels();
  const { openPanel } = usePanelContext();
  const interactive = Boolean(workspace);
  const readOnly = workspace?.readOnly ?? false;

  // Column definitions and the creation config must stay referentially stable
  // (a changed column identity remounts every cell), but `openPanel` and the
  // server-rendered `workspace` object change identity on renders that mean
  // nothing. Reading them through refs keeps them out of every dependency list.
  const openPanelRef = useRef(openPanel);
  const slugsRef = useRef<{ orgSlug: string; workspaceSlug: string } | null>(null);
  const orgSlug = workspace?.orgSlug;
  const workspaceSlug = workspace?.workspaceSlug;
  useEffect(() => {
    openPanelRef.current = openPanel;
    slugsRef.current = orgSlug && workspaceSlug ? { orgSlug, workspaceSlug } : null;
  }, [openPanel, orgSlug, workspaceSlug]);

  // Squads arrive as a fresh array on every server render; key the derived
  // options on their content so a revalidation does not rebuild the columns.
  const squadsKey = JSON.stringify(workspace?.squads ?? []);
  const squads = useMemo(
    () => JSON.parse(squadsKey) as { id: string; name: string; color: string }[],
    [squadsKey],
  );
  const noun = useMemo(
    () => ({ singular: labels.opportunity.lower, plural: labels.opportunity.lowerPlural }),
    [labels.opportunity.lower, labels.opportunity.lowerPlural],
  );
  const solutionTerms = useSolutionCreationTerms();

  // Same content-keying as squads: a revalidation hands over a fresh array.
  const parentsKey = JSON.stringify(
    workspace?.solutionParents ?? opportunities.map(({ id, title }) => ({ id, title })),
  );
  const solutionParents = useMemo(
    () => (JSON.parse(parentsKey) as { id: string; title: string }[]).map((parent) => ({ value: parent.id, label: parent.title })),
    [parentsKey],
  );

  const squadEditOptions = useMemo<GridEditOption[]>(
    () => [{ value: NO_SQUAD, label: "No squad" }, ...squads.map((squad) => ({ value: squad.id, label: squad.name }))],
    [squads],
  );

  // A stable callback that reads the slugs through a ref when it is called (from
  // the Create click), never during render.
  const submitBatch = useCallback(async (items: GridDraftSubmitItem[]): Promise<GridBatchResult> => {
    const slugs = slugsRef.current;
    if (!slugs) return { ok: false, error: "This workspace is not available." };
    const response = await createOpportunitiesBatch(slugs.orgSlug, slugs.workspaceSlug, items.map(toOpportunityBatchItem));
    if (!response.ok) return response;
    return {
      ok: true,
      results: response.results.map((result) =>
        result.ok ? result : { ...result, field: result.field ? DRAFT_FIELD_BY_SERVER_FIELD[result.field] : undefined },
      ),
    };
  }, []);

  const parentsRef = useRef(solutionParents);
  useEffect(() => {
    parentsRef.current = solutionParents;
  }, [solutionParents]);
  const submitSolutions = useCallback(
    (items: GridDraftSubmitItem[]): Promise<GridBatchResult> => submitSolutionDrafts(slugsRef.current, parentsRef.current, items),
    [],
  );

  const creationModes = useMemo<readonly GridCreationMode[] | undefined>(() => {
    if (!interactive) return undefined;
    const opportunityMode: GridCreation = { ...buildOpportunityCreation(squads, noun), submit: submitBatch };
    const solutionMode: GridCreation = {
      ...buildSolutionCreation(solutionParents, solutionTerms),
      submit: submitSolutions,
    };
    return [
      { id: "opportunities", label: `Add ${noun.plural}`, creation: opportunityMode },
      { id: "solutions", label: `Add ${solutionTerms.solution.plural}`, creation: solutionMode },
    ];
  }, [interactive, squads, noun, submitBatch, solutionParents, solutionTerms, submitSolutions]);

  // "Add solution" on a row asks the draft area to switch modes and preselect that parent.
  const [creationRequest, setCreationRequest] = useState<GridCreationRequest>();
  const requestSolutions = useCallback((opportunityId: string) => {
    setCreationRequest((previous) => ({ modeId: "solutions", parentId: opportunityId, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);
  const canCreate = interactive && !readOnly;
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
        meta: {
          label: "Item",
          hideable: false,
          minWidth: "18rem",
          ...(interactive
            ? {
                edit: {
                  kind: "text" as const,
                  field: "rowKey" as const,
                  maxLength: OPPORTUNITY_TITLE_MAX_LENGTH,
                  // Solution titles are not part of this change; their rows stay read-only.
                  isDisabled: (row: DiscoveryGridRow) => row.kind === "solution",
                  getValue: (row: DiscoveryGridRow) =>
                    row.kind === "opportunity" ? row.opportunity.title : row.solution.title,
                  applyOptimistic: (row: DiscoveryGridRow, next: string | null) =>
                    row.kind === "opportunity" ? { ...row, opportunity: { ...row.opportunity, title: next ?? row.opportunity.title } } : row,
                  parse: (text: string) => {
                    const title = text.trim();
                    if (!title) return { ok: false as const, error: "Title is required" };
                    if (title.length > OPPORTUNITY_TITLE_MAX_LENGTH) {
                      return { ok: false as const, error: `Title must be ${OPPORTUNITY_TITLE_MAX_LENGTH} characters or fewer` };
                    }
                    return { ok: true as const, value: title };
                  },
                  triggerLabel: (row: DiscoveryGridRow) =>
                    `Title for ${row.kind === "opportunity" ? row.opportunity.title : row.solution.title}`,
                  save: (row: DiscoveryGridRow, next: string | null) =>
                    row.kind === "opportunity" && slugsRef.current
                      ? saveOpportunityField(slugsRef.current, row.opportunity.id, "title", next)
                      : Promise.resolve({ ok: false as const, error: "Couldn't save that change." }),
                },
              }
            : {}),
        },
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
                  onClick={() => openPanelRef.current("solution", data.solution.id)}
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
                onClick={() => openPanelRef.current("opportunity", opportunity.id)}
                className="max-w-md truncate text-left font-medium hover:underline underline-offset-2"
              >
                {opportunity.title}
              </button>
              {canCreate && (isExpanded || opportunity.solutions.length === 0) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Add ${labels.solution.lower} to ${opportunity.title}`}
                  onClick={() => requestSolutions(opportunity.id)}
                >
                  <Plus />
                </Button>
              )}
            </div>
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
                  field: "rowKey" as const,
                  options: STATUS_OPTIONS,
                  isDisabled: (row: DiscoveryGridRow) => row.kind === "solution",
                  getValue: (row: DiscoveryGridRow) =>
                    row.kind === "opportunity" ? row.opportunity.status : row.solution.status,
                  applyOptimistic: (row: DiscoveryGridRow, next: string) =>
                    row.kind === "opportunity" ? { ...row, opportunity: { ...row.opportunity, status: next as OpportunityStatus } } : row,
                  triggerLabel: (row: DiscoveryGridRow) =>
                    `Status for ${row.kind === "opportunity" ? row.opportunity.title : row.solution.title}`,
                  save: (row: DiscoveryGridRow, next: string) =>
                    row.kind === "opportunity" && slugsRef.current
                      ? saveOpportunityField(slugsRef.current, row.opportunity.id, "status", next)
                      : Promise.resolve({ ok: false as const, error: "Couldn't save that change." }),
                },
              }
            : {}),
        },
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
        meta: {
          label: "Squad",
          width: "9rem",
          ...(interactive
            ? {
                edit: {
                  kind: "select" as const,
                  field: "rowKey" as const,
                  options: squadEditOptions,
                  isDisabled: (row: DiscoveryGridRow) => row.kind === "solution",
                  getValue: (row: DiscoveryGridRow) =>
                    row.kind === "opportunity" ? (row.opportunity.squad?.id ?? NO_SQUAD) : NO_SQUAD,
                  applyOptimistic: (row: DiscoveryGridRow, next: string) =>
                    row.kind === "opportunity"
                      ? { ...row, opportunity: { ...row.opportunity, squad: squads.find((squad) => squad.id === next) ?? null } }
                      : row,
                  triggerLabel: (row: DiscoveryGridRow) =>
                    `Squad for ${row.kind === "opportunity" ? row.opportunity.title : row.solution.title}`,
                  save: (row: DiscoveryGridRow, next: string) =>
                    row.kind === "opportunity" && slugsRef.current
                      ? saveOpportunityField(slugsRef.current, row.opportunity.id, "squadId", next === NO_SQUAD ? null : next)
                      : Promise.resolve({ ok: false as const, error: "Couldn't save that change." }),
                },
              }
            : {}),
        },
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
        meta: {
          label: "Customer segment",
          width: "10rem",
          ...(interactive
            ? {
                edit: {
                  kind: "text" as const,
                  field: "rowKey" as const,
                  maxLength: OPPORTUNITY_SEGMENT_MAX_LENGTH,
                  isDisabled: (row: DiscoveryGridRow) => row.kind === "solution",
                  getValue: (row: DiscoveryGridRow) => (row.kind === "opportunity" ? row.opportunity.customerSegment : null),
                  applyOptimistic: (row: DiscoveryGridRow, next: string | null) =>
                    row.kind === "opportunity" ? { ...row, opportunity: { ...row.opportunity, customerSegment: next } } : row,
                  triggerLabel: (row: DiscoveryGridRow) =>
                    `Customer segment for ${row.kind === "opportunity" ? row.opportunity.title : row.solution.title}`,
                  save: (row: DiscoveryGridRow, next: string | null) =>
                    row.kind === "opportunity" && slugsRef.current
                      ? saveOpportunityField(slugsRef.current, row.opportunity.id, "customerSegment", next)
                      : Promise.resolve({ ok: false as const, error: "Couldn't save that change." }),
                },
              }
            : {}),
        },
        cell: ({ row }) => {
          const data = row.original;
          if (data.kind === "solution") return <span className="text-text-subtle">—</span>;
          return data.opportunity.customerSegment ?? <span className="text-text-subtle">—</span>;
        },
      },
      // Only in the interactive table: the read-only table keeps its columns.
      ...(interactive
        ? [
            {
              id: "description",
              header: "Description",
              meta: {
                label: "Description",
                width: "14rem",
                edit: {
                  kind: "text" as const,
                  field: "rowKey" as const,
                  maxLength: BATCH_DESCRIPTION_MAX_LENGTH,
                  isDisabled: (row: DiscoveryGridRow) => row.kind === "solution",
                  getValue: (row: DiscoveryGridRow) => (row.kind === "opportunity" ? (row.opportunity.description ?? null) : null),
                  applyOptimistic: (row: DiscoveryGridRow, next: string | null) =>
                    row.kind === "opportunity" ? { ...row, opportunity: { ...row.opportunity, description: next } } : row,
                  triggerLabel: (row: DiscoveryGridRow) =>
                    `Description for ${row.kind === "opportunity" ? row.opportunity.title : row.solution.title}`,
                  save: (row: DiscoveryGridRow, next: string | null) =>
                    row.kind === "opportunity" && slugsRef.current
                      ? saveOpportunityField(slugsRef.current, row.opportunity.id, "description", next)
                      : Promise.resolve({ ok: false as const, error: "Couldn't save that change." }),
                },
              },
              cell: ({ row }: { row: { original: DiscoveryGridRow } }) => {
                const data = row.original;
                const text = data.kind === "opportunity" ? data.opportunity.description : null;
                return text ? <span className="block truncate">{text}</span> : <span className="text-text-subtle">—</span>;
              },
            } satisfies GridColumnDef<DiscoveryGridRow>,
          ]
        : []),
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
                : countLabel(data.opportunity.solutions.length, labels.solution.lower, labels.solution.lowerPlural)}
            </Badge>
          );
        },
      },
    ],
    // Both dependencies are stable across a toggle, so expanding a row updates
    // the affected cells in place instead of remounting every cell in the
    // table — see the note on `DiscoveryGridRow.isExpanded`.
    [interactive, canCreate, requestSolutions, squads, squadEditOptions, toggleOpportunity, labels],
  );

  // The "no opportunities at all" case keeps its own dashed box instead of the
  // grid's `emptyState`, which would nest it inside the grid's panel chrome.
  // With the draft area available (not read-only) an empty list must still render the grid, or a workspace's
  // first opportunities could never be created here.
  if (opportunities.length === 0 && !canCreate) {
    return (
      <div className="rounded-xl border border-dashed border-border-default px-4 py-12 text-center text-sm text-text-secondary">
        {`No ${labels.opportunity.lowerPlural} match the current filters.`}
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
      caption={`Discovery ${labels.opportunity.lowerPlural}`}
      height="fill"
      pagination={false}
      toolbar={false}
      emptyState={`No ${labels.opportunity.lowerPlural} match the current filters.`}
      interaction={interactive ? "sheet" : undefined}
      readOnly={readOnly}
      onOpenRow={
        interactive
          ? (row) =>
              row.kind === "solution"
                ? openPanelRef.current("solution", row.solution.id)
                : openPanelRef.current("opportunity", row.opportunity.id)
          : undefined
      }
      creationModes={creationModes}
      creationRequest={creationRequest}
      rowClassName={(row) => (row.kind === "solution" ? "bg-surface-inset/50" : undefined)}
      className="overflow-hidden rounded-xl border border-border-default bg-surface-panel"
    />
  );
}
