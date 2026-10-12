"use client";

import { useMemo } from "react";
import { useUrlState } from "@/hooks/use-url-state";
import { ROADMAP_URL_PARAMS } from "@/lib/roadmap-views/schema";
import type { RoadmapViewRecord } from "@/lib/roadmap-views/service";
import { resolveWorkspaceRoadmapState } from "@/lib/roadmap-views/workspace";
import { SavedViewsMenu } from "./cross-workspace/saved-views-menu";

/** What the workspace roadmap page hands the header so it can offer saved views. */
export type WorkspaceSavedViews = {
  orgSlug: string;
  workspaceId: string;
  views: RoadmapViewRecord[];
  savedViewId: string | null;
  /** The live URL state differs from the selected saved view. */
  modified: boolean;
  canShare: boolean;
};

/**
 * The saved-views picker for one workspace's roadmap. The live state is read back
 * off the URL (squad, custom-field filter, grouping, board/timeline) with the same
 * resolver the server page uses, so "Save" captures exactly what is on screen.
 */
export function WorkspaceSavedViewsMenu({ savedViews }: { savedViews: WorkspaceSavedViews }) {
  const { params, setAll } = useUrlState();
  const saved = useMemo(
    () => savedViews.views.find((v) => v.id === savedViews.savedViewId) ?? null,
    [savedViews.views, savedViews.savedViewId],
  );
  const state = useMemo(
    () => resolveWorkspaceRoadmapState(Object.fromEntries(params.entries()), saved),
    [params, saved],
  );

  return (
    <SavedViewsMenu
      orgSlug={savedViews.orgSlug}
      surfaceWorkspaceId={savedViews.workspaceId}
      views={savedViews.views}
      savedViewId={savedViews.savedViewId}
      modified={savedViews.modified}
      state={state}
      canShare={savedViews.canShare}
      // A bare `?saved=<id>`; the page expands it to the view's full state.
      onSelect={(view) => setAll(view ? new URLSearchParams({ [ROADMAP_URL_PARAMS.savedView]: view.id }) : new URLSearchParams())}
    />
  );
}
