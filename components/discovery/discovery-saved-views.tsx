"use client";

import { useMemo } from "react";
import { SavedViewsMenu } from "@/components/saved-views/saved-views-menu";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { useUrlState } from "@/hooks/use-url-state";
import {
  OPPORTUNITIES_URL_PARAMS,
  isOpportunitiesStateModified,
  resolveSurfaceState,
  type OpportunitiesState,
} from "@/lib/saved-views/opportunities-state";
import type { SavedViewRecord } from "@/lib/saved-views/service";

/** What the Discovery page hands its header controls so they can offer saved views. */
export type DiscoverySavedViews = {
  orgSlug: string;
  workspaceId: string;
  /** The viewer's own views on this board (personal only for now). */
  views: SavedViewRecord[];
  /** The selected view, only when it exists and is visible here; a stale id is already dropped. */
  savedViewId: string | null;
  /** Read-only members use views and change columns locally, but cannot save. */
  canSave: boolean;
};

/**
 * The live state of the board as the URL describes it, resolved with the same pure
 * function the server page uses, so "Save" captures exactly what is on screen.
 */
export function useDiscoveryViewState(savedViews: Pick<DiscoverySavedViews, "views" | "savedViewId">) {
  const { params, setAll } = useUrlState();
  const saved = useMemo(
    () => savedViews.views.find((v) => v.id === savedViews.savedViewId) ?? null,
    [savedViews.views, savedViews.savedViewId],
  );
  const savedState = useMemo<OpportunitiesState | null>(
    () => (saved ? { filters: saved.filters as OpportunitiesState["filters"], display: saved.display as OpportunitiesState["display"] } : null),
    [saved],
  );
  const state = useMemo(
    () => resolveSurfaceState("OPPORTUNITIES_BOARD", Object.fromEntries(params.entries()), savedState),
    [params, savedState],
  );
  return { state, saved, savedState, modified: isOpportunitiesStateModified(state, savedState), setAll };
}

export function DiscoverySavedViewsMenu({ savedViews }: { savedViews: DiscoverySavedViews }) {
  const labels = useLabels();
  const { state, modified, setAll } = useDiscoveryViewState(savedViews);

  return (
    <SavedViewsMenu
      orgSlug={savedViews.orgSlug}
      surface="OPPORTUNITIES_BOARD"
      surfaceWorkspaceId={savedViews.workspaceId}
      views={savedViews.views}
      savedViewId={savedViews.savedViewId}
      modified={modified}
      state={state}
      canShare={false}
      canSave={savedViews.canSave}
      extendedActions
      deleteNote={`${labels.opportunity.plural} are not affected.`}
      // A bare `?saved=<id>`; the page expands it to the view's full state. Also what "Reset" does.
      onSelect={(view) => setAll(view ? new URLSearchParams({ [OPPORTUNITIES_URL_PARAMS.savedView]: view.id }) : new URLSearchParams())}
    />
  );
}
