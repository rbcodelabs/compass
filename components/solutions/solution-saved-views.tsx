"use client";

import { useMemo } from "react";
import { SavedViewsMenu } from "@/components/saved-views/saved-views-menu";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { useUrlState } from "@/hooks/use-url-state";
import type { DiscoverySavedViews } from "@/components/discovery/discovery-saved-views";
import { useSolutionsColumnLayoutContext } from "@/components/solutions/solutions-column-layout";
import { effectiveStoredLayout, resolveSolutionBoardLayout } from "@/lib/solutions/board-layout";
import {
  SOLUTIONS_URL_PARAMS,
  isSolutionsStateModified,
  resolveSolutionsState,
  withLiveColumnLayout,
  type SolutionsState,
} from "@/lib/saved-views/solutions-state";

/**
 * The live state of the Solutions board. `urlState` is what the URL describes, resolved with the same pure function the
 * server page uses (build hrefs from this). `state` is that plus the board's column layout, which is client state (see
 * solutions-column-layout.tsx): it is what Save captures and what "modified" compares.
 */
export function useSolutionViewState(savedViews: Pick<DiscoverySavedViews, "views" | "savedViewId">) {
  const { params, setAll } = useUrlState();
  const columnLayout = useSolutionsColumnLayoutContext();
  const saved = useMemo(
    () => savedViews.views.find((v) => v.id === savedViews.savedViewId) ?? null,
    [savedViews.views, savedViews.savedViewId],
  );
  const savedState = useMemo(
    (): SolutionsState | null => (saved ? { filters: saved.filters as SolutionsState["filters"], display: saved.display as SolutionsState["display"] } : null),
    [saved],
  );
  const urlState = useMemo(
    () => resolveSolutionsState(Object.fromEntries(params.entries()), savedState),
    [params, savedState],
  );
  const state = useMemo(
    () => (columnLayout ? withLiveColumnLayout(urlState, columnLayout.layout) : urlState),
    [urlState, columnLayout],
  );
  return { state, urlState, saved, savedState, modified: isSolutionsStateModified(state, savedState), setAll, columnLayout };
}

export function SolutionSavedViewsMenu({ savedViews }: { savedViews: DiscoverySavedViews }) {
  const labels = useLabels();
  const { state, modified, setAll, savedState, columnLayout } = useSolutionViewState(savedViews);

  return (
    <SavedViewsMenu
      orgSlug={savedViews.orgSlug}
      surface="SOLUTIONS_BOARD"
      surfaceWorkspaceId={savedViews.workspaceId}
      views={savedViews.views}
      savedViewId={savedViews.savedViewId}
      modified={modified}
      state={state}
      canShare={false}
      canSave={savedViews.canSave}
      extendedActions
      deleteNote={labels.solution.plural + " are not affected."}
      onSelect={(view) => {
        // Re-selecting the view already open is "Reset": the URL goes back to the view, and so must the board's column layout
        // (client state that a URL change alone would not touch).
        if (view && view.id === savedViews.savedViewId && savedState && columnLayout) {
          columnLayout.update(() => resolveSolutionBoardLayout(effectiveStoredLayout(savedState.display)));
        }
        setAll(view ? new URLSearchParams({ [SOLUTIONS_URL_PARAMS.savedView]: view.id }) : new URLSearchParams());
      }}
    />
  );
}
