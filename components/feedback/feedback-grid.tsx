"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Bug, Lightbulb } from "lucide-react";

import { DataGrid } from "@/components/data-grid";
import type { GridRowState } from "@/components/data-grid";
import { CreateFeedbackDialog } from "@/components/feedback/create-feedback-dialog";
import { FeedbackAttachments } from "@/components/feedback/feedback-attachments";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { useUrlState } from "@/hooks/use-url-state";
import {
  FEEDBACK_PAGE_SIZES,
  serializeFeedbackQuery,
  type FeedbackQuery,
  type FeedbackQueryPatch,
} from "@/lib/feedback-query";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_META,
  feedbackStatusLabel,
  feedbackStatusTone,
  feedbackTypeLabel,
  feedbackTypeTone,
  formatFeedbackDate,
} from "@/lib/feedback-meta";
import { cn } from "@/lib/utils";
import {
  buildFeedbackColumns,
  type FeedbackOpportunityOption,
  type FeedbackRow,
} from "./feedback-columns";
import { FeedbackActionCell } from "./feedback-action-cell";

/**
 * The Feedback screen's client shell.
 *
 * Sorting, filtering and pagination all execute in Postgres — this component
 * only ever *writes the URL*, and the server page re-runs the query. That is
 * what makes a filtered view shareable by copying the address bar.
 *
 * The rule that is easy to get wrong: **an inline edit must not refresh this
 * route.** That is stricter than "don't call `router.refresh()`". Verified in a
 * real browser: a Server Action that calls `revalidatePath` at all — even for an
 * unrelated path — makes Next re-deliver the RSC payload for the route the
 * action was invoked from, which yanks the just-edited row out from under the
 * user and destroys stay-and-mark. So the grid's inline edits pass a `null`
 * revalidate path (see `RevalidateTarget` in the feedback actions module);
 * callers without an optimistic overlay still pass a real path.
 *
 * `router.refresh()` appears exactly twice below: behind the stale strip's
 * explicit "Refresh" button, and after a create — both deliberate, user-
 * initiated reconciliations, never a side effect of editing a cell.
 */

/** Search params this screen owns. Anything else on the URL is preserved. */
const OWNED_PARAMS = ["q", "status", "type", "sort", "dir", "page", "per"] as const;

const FEEDBACK_TYPE_FILTER_OPTIONS = [
  { value: "IDEA", label: "Ideas" },
  { value: "BUG", label: "Bugs" },
] as const;

export type FeedbackGridProps = {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  /** The current server page, already mapped to row shape. */
  items: FeedbackRow[];
  opportunities: FeedbackOpportunityOption[];
  /** Server-reported total for the *filtered* query. */
  total: number;
  /** The validated query the server ran. */
  query: FeedbackQuery;
  /**
   * Whether the workspace has any feedback at all, ignoring filters. Drives the
   * full "no feedback yet" empty state vs. the compact "nothing matches" one.
   */
  hasAnyFeedback: boolean;
};

export function FeedbackGrid({
  orgSlug,
  workspaceSlug,
  workspaceId,
  items,
  opportunities,
  total,
  query,
  hasAnyFeedback,
}: FeedbackGridProps) {
  const router = useRouter();
  const { openPanel } = usePanelContext();
  const urlState = useUrlState();

  const feedbackPath = `/${orgSlug}/${workspaceSlug}/feedback`;
  const roadmapPath = `/${orgSlug}/${workspaceSlug}/roadmap`;

  /**
   * Apply a patch to the query and push the resulting URL.
   *
   * `serializeFeedbackQuery` owns the page-reset invariant (any filter/sort/
   * page-size change goes back to page 1), so callers never have to remember
   * it. Params this screen does not own — notably the detail panel's `detail`
   * — are carried across, so sorting a column does not slam the panel shut.
   */
  const applyPatch = useCallback(
    (patch: FeedbackQueryPatch) => {
      const next = serializeFeedbackQuery(query, patch);
      for (const [key, value] of urlState.params.entries()) {
        if ((OWNED_PARAMS as readonly string[]).includes(key)) continue;
        if (!next.has(key)) next.append(key, value);
      }
      urlState.setAll(next);
    },
    [query, urlState],
  );

  const columns = useMemo(
    () =>
      buildFeedbackColumns({
        opportunities,
        workspaceId,
        roadmapPath,
        onOpen: (id) => openPanel("feedback", id),
      }),
    [opportunities, workspaceId, roadmapPath, openPanel],
  );

  /**
   * Does a row (with any optimistic edit already merged in) still satisfy the
   * filters the *server* ran? Wiring this is what turns an inline edit that
   * pushes a row out of the current query into a "stay and mark stale" instead
   * of a silent desync.
   */
  const rowMatchesFilters = useCallback(
    (row: FeedbackRow) => {
      if (!query.status.some((status) => status === row.status)) return false;
      if (query.type && row.type !== query.type) return false;
      if (query.q) {
        const needle = query.q.toLowerCase();
        const haystack = `${row.title} ${row.description ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    },
    [query.status, query.type, query.q],
  );

  const renderMobileRow = useCallback(
    (row: FeedbackRow, state: GridRowState<FeedbackRow>) => (
      <div
        className={cn(
          "flex flex-col gap-2 rounded-xl border border-border-default bg-surface-panel p-3",
          state?.pending && "opacity-60",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => openPanel("feedback", row.id)}
            className="min-w-0 flex-1 text-left text-sm font-medium text-text-primary underline-offset-2 hover:underline"
          >
            {row.title}
          </button>
          <span className="shrink-0 text-sm font-semibold text-text-primary">
            {row.voteCount} votes
          </span>
        </div>

        {row.description && (
          <p className="line-clamp-2 text-xs text-text-subtle">{row.description}</p>
        )}

        <FeedbackAttachments attachments={row.attachments} />

        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge
            status={feedbackTypeTone(row.type)}
            icon={row.type === "BUG" ? <Bug aria-hidden /> : <Lightbulb aria-hidden />}
          >
            {feedbackTypeLabel(row.type)}
          </StatusBadge>
          <StatusBadge status={feedbackStatusTone(row.status)}>
            {feedbackStatusLabel(row.status)}
          </StatusBadge>
          <span className="text-xs text-text-subtle">
            {formatFeedbackDate(row.createdAt)}
          </span>
        </div>

        {/*
          Status and type are read-only badges on the stacked card: the mobile
          card is not wide enough for two pickers plus the action control, and
          tapping the title opens the detail panel, which has full status/type
          editors. The action control stays inline because promote/link is the
          triage step the board exists for.
        */}
        <FeedbackActionCell
          row={row}
          opportunities={opportunities}
          workspaceId={workspaceId}
          roadmapPath={roadmapPath}
        />

        {state?.error && (
          <p role="alert" className="text-xs text-status-danger">
            {state.error}
          </p>
        )}
      </div>
    ),
    [openPanel, opportunities, workspaceId, roadmapPath],
  );

  // A workspace with no feedback at all gets the full call-to-action empty
  // state and no grid chrome — there is nothing to sort, filter or paginate.
  if (!hasAnyFeedback) {
    return (
      <EmptyState
        title="No feedback submitted yet"
        description="Enable the public feedback portal in Settings to start collecting submissions, or log one yourself below."
        primaryAction={
          <CreateFeedbackDialog
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            revalidatePathStr={feedbackPath}
            onCreated={() => router.refresh()}
            variant="empty-state"
          />
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <DataGrid<FeedbackRow>
        gridId="feedback"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        total={total}
        page={query.page}
        pageSize={query.per}
        pageSizes={FEEDBACK_PAGE_SIZES}
        onPageChange={(page) => applyPatch({ page })}
        onPageSizeChange={(per) => applyPatch({ per })}
        sort={query.sort ? { key: query.sort, dir: query.dir } : null}
        // Direction is the caller's job: `serializeFeedbackQuery` flips the
        // active column and uses each other column's natural first direction.
        onSortChange={(sortKey) => applyPatch({ sort: sortKey })}
        caption="Customer feedback, sortable and filterable. Use the column headers to sort and the Filters menu to narrow the list."
        toolbarPortalId="feedback-header-toolbar"
        searchDisplay="popover"
        search={{
          value: query.q ?? "",
          onChange: (value) => applyPatch({ q: value || null }),
          placeholder: "Search feedback",
          label: "Search feedback",
        }}
        filters={[
          {
            id: "type",
            label: "Type",
            value: query.type,
            allLabel: "All",
            options: [...FEEDBACK_TYPE_FILTER_OPTIONS],
            onValueChange: (value) => applyPatch({ type: value }),
          },
          {
            id: "status",
            label: "Status",
            values: query.status,
            options: FEEDBACK_STATUSES.map((status) => ({
              value: status,
              label: FEEDBACK_STATUS_META[status].label,
            })),
            onValuesChange: (values) => applyPatch({ status: values }),
          },
        ]}
        onClearFilters={() => applyPatch({ status: null, type: null })}
        renderMobileRow={renderMobileRow}
        rowMatchesFilters={rowMatchesFilters}
        onRefresh={() => router.refresh()}
        emptyState={
          <EmptyState
            compact
            title="No feedback matches these filters"
            description="Try clearing the search or the Filters menu."
          />
        }
      />
    </div>
  );
}
