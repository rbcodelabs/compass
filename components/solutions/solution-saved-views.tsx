"use client";

import { useMemo } from "react";
import { SavedViewsMenu } from "@/components/saved-views/saved-views-menu";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { useUrlState } from "@/hooks/use-url-state";
import type { DiscoverySavedViews } from "@/components/discovery/discovery-saved-views";
import {
  SOLUTIONS_URL_PARAMS,
  isSolutionsStateModified,
  resolveSolutionsState,
  type SolutionsState,
} from "@/lib/saved-views/solutions-state";

/** The live state of the Solutions board as the URL describes it, resolved with the same pure function the server page uses. */
export function useSolutionViewState(savedViews: Pick<DiscoverySavedViews, "views" | "savedViewId">) {
  const { params, setAll } = useUrlState();
  const saved = useMemo(
    () => savedViews.views.find((v) => v.id === savedViews.savedViewId) ?? null,
    [savedViews.views, savedViews.savedViewId],
  );
  const savedState = useMemo(
    (): SolutionsState | null => (saved ? { filters: saved.filters as SolutionsState["filters"], display: saved.display as SolutionsState["display"] } : null),
    [saved],
  );
  const state = useMemo(
    () => resolveSolutionsState(Object.fromEntries(params.entries()), savedState),
    [params, savedState],
  );
  return { state, saved, savedState, modified: isSolutionsStateModified(state, savedState), setAll };
}

export function SolutionSavedViewsMenu({ savedViews }: { savedViews: DiscoverySavedViews }) {
  const labels = useLabels();
  const { state, modified, setAll } = useSolutionViewState(savedViews);

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
      onSelect={(view) => setAll(view ? new URLSearchParams({ [SOLUTIONS_URL_PARAMS.savedView]: view.id }) : new URLSearchParams())}
    />
  );
}
