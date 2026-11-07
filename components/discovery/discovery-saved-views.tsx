"use client";

import { useMemo } from "react";
import { SavedViewsMenu } from "@/components/saved-views/saved-views-menu";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { useUrlState } from "@/hooks/use-url-state";
import { useOpportunitiesColumnLayoutContext } from "@/components/discovery/discovery-column-layout";
import { effectiveStoredLayout, resolveOpportunityBoardLayout } from "@/lib/discovery/board-layout";
import {
  OPPORTUNITIES_URL_PARAMS,
  isOpportunitiesStateModified,
  resolveSurfaceState,
  withLiveColumnLayout,
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
 * The live state of the board. `urlState` is what the URL describes, resolved with the same pure function the server
 * page uses (build hrefs from this). `state` is that plus the board's column layout, which is client state (see
 * discovery-column-layout.tsx): it is what "Save" captures, so it captures exactly what is on screen, and what "modified" compares.
 */
export function useDiscoveryViewState(savedViews: Pick<DiscoverySavedViews, "views" | "savedViewId">) {
  const { params, setAll } = useUrlState();
  const columnLayout = useOpportunitiesColumnLayoutContext();
  const saved = useMemo(
    () => savedViews.views.find((v) => v.id === savedViews.savedViewId) ?? null,
    [savedViews.views, savedViews.savedViewId],
  );
  const savedState = useMemo<OpportunitiesState | null>(
    () => (saved ? { filters: saved.filters as OpportunitiesState["filters"], display: saved.display as OpportunitiesState["display"] } : null),
    [saved],
  );
  const urlState = useMemo(
    () => resolveSurfaceState("OPPORTUNITIES_BOARD", Object.fromEntries(params.entries()), savedState),
    [params, savedState],
  );
  const state = useMemo(
    () => (columnLayout ? withLiveColumnLayout(urlState, columnLayout.layout) : urlState),
    [urlState, columnLayout],
  );
  return { state, urlState, saved, savedState, modified: isOpportunitiesStateModified(state, savedState), setAll, columnLayout };
}

export function DiscoverySavedViewsMenu({ savedViews }: { savedViews: DiscoverySavedViews }) {
  const labels = useLabels();
  const { state, modified, setAll, savedState, columnLayout } = useDiscoveryViewState(savedViews);

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
      onSelect={(view) => {
        // Re-selecting the view already open is "Reset": the URL goes back to the view, and so must the board's column layout
        // (client state that a URL change alone would not touch).
        if (view && view.id === savedViews.savedViewId && savedState && columnLayout) {
          columnLayout.update(() => resolveOpportunityBoardLayout(effectiveStoredLayout(savedState.display)));
        }
        setAll(view ? new URLSearchParams({ [OPPORTUNITIES_URL_PARAMS.savedView]: view.id }) : new URLSearchParams());
      }}
    />
  );
}
