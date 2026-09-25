"use client";

import type { ReactNode } from "react";
import { Bug, Lightbulb, ThumbsUp } from "lucide-react";

import {
  updateFeedbackStatus,
  updateFeedbackType,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import { FeedbackAttachments, type FeedbackAttachmentData } from "@/components/feedback/feedback-attachments";
import { StatusBadge } from "@/components/patterns/status-badge";
import type { GridColumnDef, GridEditOption } from "@/components/data-grid";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_META,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_META,
  feedbackStatusLabel,
  feedbackStatusTone,
  feedbackTypeLabel,
  feedbackTypeTone,
  formatFeedbackDate,
} from "@/lib/feedback-meta";
import type { FeedbackType } from "@/lib/types";
import { markdownToPlainText } from "@/lib/markdown-plain-text";
import { FeedbackActionCell } from "./feedback-action-cell";

/**
 * Column definitions for the Feedback grid.
 *
 * Every label and tone comes from `lib/feedback-meta.ts` — there are no raw
 * palette classes here, which is what `pnpm ui:colors` enforces.
 *
 * `submitted` is deliberately its own sortable column rather than a line in the
 * title cell's meta row: an intentional visual change from the old card board,
 * and the only way "sort by date" can exist at all.
 */

export type FeedbackRow = {
  id: string;
  title: string;
  description: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  status: string;
  voteCount: number;
  type: FeedbackType;
  opportunityId: string | null;
  roadmapItem: { id: string; title: string; horizon: string } | null;
  createdAt: string;
  attachments: FeedbackAttachmentData[];
};

export type FeedbackOpportunityOption = { id: string; title: string };

/** Icon *components* for a type — `feedback-meta` only stores the name. */
function typeIcon(type: string): ReactNode {
  if (type === "BUG") return <Bug aria-hidden />;
  if (type === "IDEA") return <Lightbulb aria-hidden />;
  return null;
}

const TYPE_OPTIONS: GridEditOption[] = FEEDBACK_TYPES.map((type) => ({
  value: type,
  label: FEEDBACK_TYPE_META[type].label,
  icon: typeIcon(type),
}));

const STATUS_OPTIONS: GridEditOption[] = FEEDBACK_STATUSES.map((status) => ({
  value: status,
  label: FEEDBACK_STATUS_META[status].label,
}));

export type BuildFeedbackColumnsOptions = {
  opportunities: readonly FeedbackOpportunityOption[];
  workspaceId: string;
  /** `/{org}/{workspace}/roadmap` */
  roadmapPath: string;
  /** Opens the detail panel for a feedback item. */
  onOpen: (id: string) => void;
};

export function buildFeedbackColumns({
  opportunities,
  workspaceId,
  roadmapPath,
  onOpen,
}: BuildFeedbackColumnsOptions): GridColumnDef<FeedbackRow>[] {
  return [
    {
      id: "feedback",
      header: "Feedback",
      accessorKey: "title",
      meta: {
        label: "Feedback",
        sortable: true,
        // Free-text search lives in `q`; the header sorts by title.
        sortKey: "title",
        // No width — absorbs the remainder under `table-fixed` — with an 18rem
        // floor so it cannot collapse against the other columns' 44rem. This
        // grid drops to stacked cards below `md`, where the grid skips the
        // table `min-width` entirely, so the floor only governs the band
        // between `md` and a container wide enough for the full 62rem.
        minWidth: "18rem",
        // `components/ui/table.tsx`'s TableCell is `whitespace-nowrap`, which
        // silently defeats `line-clamp-1` — the description renders as one
        // unwrapped line that gets sliced off at the cell edge with no
        // ellipsis. Re-enabling normal wrapping lets the clamp do its job.
        // The title keeps its own `truncate` (which sets nowrap itself).
        cellClassName: "whitespace-normal align-top",
      },
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="w-fit max-w-full truncate text-left text-sm font-medium text-text-primary underline-offset-2 hover:underline"
            >
              {item.title}
            </button>
            {item.description && (
              <p className="line-clamp-1 text-xs text-text-subtle">
                {markdownToPlainText(item.description)}
              </p>
            )}
            <FeedbackAttachments attachments={item.attachments} />
            {(item.submitterName || item.submitterEmail) && (
              <div className="mt-0.5 flex items-center gap-2">
                {item.submitterName && (
                  <span className="truncate text-xs text-text-subtle">
                    {item.submitterName}
                  </span>
                )}
                {item.submitterEmail && (
                  <span className="truncate text-xs text-text-subtle">
                    {item.submitterEmail}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      },
    },

    {
      id: "type",
      header: "Type",
      accessorKey: "type",
      meta: {
        label: "Type",
        sortable: true,
        sortKey: "type",
        width: "8rem",
        edit: {
          kind: "select",
          options: TYPE_OPTIONS,
          field: "type",
          getValue: (row) => row.type,
          triggerLabel: (row) => `Type for ${row.title}`,
          renderTrigger: (_option, row) => (
            <StatusBadge
              status={feedbackTypeTone(row.type)}
              icon={typeIcon(row.type)}
            >
              {feedbackTypeLabel(row.type)}
            </StatusBadge>
          ),
          // The grid owns the whole optimistic cycle; `save` must resolve,
          // never reject — `updateFeedbackType` returns a result object for
          // exactly this reason.
          //
          // `null` revalidate path is deliberate and verified in a real
          // browser: a Server Action that revalidates *anything* makes Next
          // re-deliver the RSC payload for the route it was called from, which
          // pulls the just-edited row out from under the user and destroys
          // stay-and-mark. See `RevalidateTarget` in the actions module.
          save: (row, next) => updateFeedbackType(row.id, next, null),
        },
      },
    },

    {
      id: "votes",
      header: "Votes",
      accessorKey: "voteCount",
      meta: {
        label: "Votes",
        sortable: true,
        sortKey: "votes",
        width: "6rem",
        align: "end",
      },
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-text-primary">
          <ThumbsUp aria-hidden className="size-3.5 text-text-subtle" />
          {row.original.voteCount}
        </span>
      ),
    },

    {
      id: "status",
      header: "Status",
      accessorKey: "status",
      meta: {
        label: "Status",
        sortable: true,
        sortKey: "status",
        width: "10rem",
        edit: {
          kind: "select",
          options: STATUS_OPTIONS,
          field: "status",
          getValue: (row) => row.status,
          triggerLabel: (row) => `Status for ${row.title}`,
          renderTrigger: (_option, row) => (
            <StatusBadge status={feedbackStatusTone(row.status)}>
              {feedbackStatusLabel(row.status)}
            </StatusBadge>
          ),
          // `null` revalidate path — see the `type` column above.
          save: (row, next) => updateFeedbackStatus(row.id, next, null),
        },
      },
    },

    {
      id: "submitted",
      header: "Submitted",
      accessorKey: "createdAt",
      meta: {
        label: "Submitted",
        sortable: true,
        sortKey: "created",
        width: "8rem",
      },
      cell: ({ row }) => (
        <span className="text-xs text-text-subtle">
          {formatFeedbackDate(row.original.createdAt)}
        </span>
      ),
    },

    {
      id: "action",
      header: "Action",
      // Not a data column: no accessor, no sort, no filter. `hideable: false`
      // both keeps it out of the column menu and pins it to its declared index,
      // which is last — i.e. pinned to the END of the row.
      meta: { label: "Action", hideable: false, width: "12rem" },
      cell: ({ row }) => (
        <FeedbackActionCell
          row={row.original}
          opportunities={opportunities}
          workspaceId={workspaceId}
          roadmapPath={roadmapPath}
        />
      ),
    },
  ];
}
