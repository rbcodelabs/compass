"use client";

import { useState, useTransition } from "react";
import { Link2, Loader2, Rocket } from "lucide-react";

import { linkFeedbackToOpportunity } from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import { promoteFeedbackToRoadmap } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
  type ComboboxItemData,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/patterns/status-badge";
import { HORIZON_META, PROMOTE_TARGET_HORIZONS } from "@/lib/roadmap";
import type { Horizon } from "@/lib/types";
import type { FeedbackOpportunityOption, FeedbackRow } from "./feedback-columns";

/**
 * The `action` column's cell.
 *
 * This is not a data column — it has no accessor, no sort and no filter — so
 * it cannot go through the grid's generic `meta.edit` optimistic pipeline. It
 * owns its own state instead, and branches on the row's type:
 *
 *  - **BUG** → promote straight to the roadmap, or show the roadmap chip if it
 *    is already there. Promotion is deliberately **pessimistic**: it creates a
 *    RoadmapItem server-side and the chip needs the horizon that comes back, so
 *    there is nothing honest to show optimistically. A spinner renders in the
 *    cell instead.
 *  - **IDEA** → link an Opportunity. This one *is* optimistic (the value is
 *    known up front), with a rollback + inline error on failure.
 *
 * Errors are inline `role="alert"` text. There is no toast library in this repo
 * and one is not being added.
 */

const HORIZON_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(HORIZON_META).map(([horizon, meta]) => [horizon, meta.label]),
);

function horizonLabel(horizon: string): string {
  return HORIZON_LABELS[horizon] ?? horizon;
}

export type FeedbackActionCellProps = {
  row: FeedbackRow;
  opportunities: readonly FeedbackOpportunityOption[];
  workspaceId: string;
  /** `/{org}/{workspace}/roadmap` */
  roadmapPath: string;
};

export function FeedbackActionCell({
  row,
  opportunities,
  workspaceId,
}: FeedbackActionCellProps) {
  const [isPromoting, startPromote] = useTransition();
  // Server truth for a freshly promoted row does not arrive until a refresh
  // (promote revalidates the roadmap path, not this one), so the cell keeps the
  // returned item locally. A real refresh replaces it with the server value.
  const [promoted, setPromoted] = useState<{ title: string; horizon: string } | null>(
    null,
  );
  const [linkedId, setLinkedId] = useState<string | null>(row.opportunityId);
  const [linkPending, setLinkPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roadmapItem = row.roadmapItem ?? promoted;

  if (row.type === "BUG") {
    if (roadmapItem) {
      return (
        <StatusBadge
          status="success"
          icon={<Rocket />}
          data-testid="feedback-on-roadmap"
          className="max-w-full"
        >
          <span className="truncate">
            On roadmap ({horizonLabel(roadmapItem.horizon)})
          </span>
        </StatusBadge>
      );
    }

    return (
      <div className="flex flex-col gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="w-full justify-start"
                disabled={isPromoting}
                aria-label={`Promote ${row.title} to roadmap`}
                data-testid="feedback-promote"
              />
            }
          >
            {isPromoting ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Rocket aria-hidden />
            )}
            <span className="truncate">Promote to roadmap</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {PROMOTE_TARGET_HORIZONS.map((horizon: Horizon) => (
              <DropdownMenuItem
                key={horizon}
                onClick={() => {
                  setError(null);
                  startPromote(async () => {
                    try {
                      const item = await promoteFeedbackToRoadmap(
                        row.id,
                        workspaceId,
                        horizon,
                      );
                      setPromoted({ title: item.title, horizon });
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not promote this item.",
                      );
                    }
                  });
                }}
              >
                {horizonLabel(horizon)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {error && (
          <p role="alert" className="text-xs text-status-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  // ── IDEA: link an opportunity ─────────────────────────────────────────────
  const items: ComboboxItemData[] = opportunities.map((opportunity) => ({
    value: opportunity.id,
    label: opportunity.title,
  }));

  function handleLink(next: string | null) {
    const previous = linkedId;
    if (next === previous) return;
    setLinkedId(next);
    setLinkPending(true);
    setError(null);
    // `null` revalidate path: this cell holds an optimistic value too, and a
    // Server Action that revalidates anything re-delivers this route's RSC
    // payload (verified in a browser — see `RevalidateTarget` in the actions
    // module), which would fight the local state below.
    void linkFeedbackToOpportunity(row.id, next, null).then((result) => {
      setLinkPending(false);
      if (!result.ok) {
        setLinkedId(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Combobox
        items={items}
        value={linkedId}
        onValueChange={handleLink}
        disabled={linkPending}
      >
        <ComboboxTrigger
          size="sm"
          className="w-full max-w-full"
          aria-label={`Link ${row.title} to an opportunity`}
          aria-invalid={error ? true : undefined}
          data-error={error ? "true" : undefined}
          data-testid="feedback-link-opportunity"
        >
          <Link2 aria-hidden className="size-3 shrink-0 text-text-subtle" />
          <ComboboxValue placeholder="Link opportunity" />
        </ComboboxTrigger>
        <ComboboxContent
          align="end"
          emptyMessage="No opportunities."
          inputPlaceholder="Search opportunities…"
        />
      </Combobox>
      {error && (
        <p role="alert" className="text-xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
