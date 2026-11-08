"use client";

import { useMemo } from "react";
import { SavedViewsMenu } from "@/components/saved-views/saved-views-menu";
import { useUrlState } from "@/hooks/use-url-state";
import type { DiscoverySavedViews } from "@/components/discovery/discovery-saved-views";
import { useTasksColumnLayoutContext } from "@/components/tasks/tasks-column-layout";
import { resolveTaskBoardLayout } from "@/lib/tasks/board-layout";
import {
  TASKS_URL_PARAMS,
  isTasksStateModified,
  resolveTasksState,
  withLiveColumnLayout,
  type TasksState,
} from "@/lib/saved-views/tasks-state";

/** What the Tasks page hands its header so it can offer saved views (same shape the other boards use). */
export type TasksSavedViews = DiscoverySavedViews;

/**
 * The live state of the Tasks page. `urlState` is what the URL describes, resolved with the same pure function the server
 * page uses. `state` is that plus the board's column layout, which is client state (see tasks-column-layout.tsx): it is
 * what Save captures and what "modified" compares.
 */
export function useTasksViewState(savedViews: Pick<TasksSavedViews, "views" | "savedViewId">) {
  const { params, setAll } = useUrlState();
  const columnLayout = useTasksColumnLayoutContext();
  const saved = useMemo(
    () => savedViews.views.find((v) => v.id === savedViews.savedViewId) ?? null,
    [savedViews.views, savedViews.savedViewId],
  );
  const savedState = useMemo(
    (): TasksState | null => (saved ? { filters: saved.filters as TasksState["filters"], display: saved.display as TasksState["display"] } : null),
    [saved],
  );
  const urlState = useMemo(() => resolveTasksState(Object.fromEntries(params.entries()), savedState), [params, savedState]);
  const state = useMemo(
    () => (columnLayout ? withLiveColumnLayout(urlState, columnLayout.layout) : urlState),
    [urlState, columnLayout],
  );
  return { state, urlState, saved, savedState, modified: isTasksStateModified(state, savedState), setAll, columnLayout };
}

export function TasksSavedViewsMenu({ savedViews }: { savedViews: TasksSavedViews }) {
  const { state, modified, setAll, savedState, columnLayout } = useTasksViewState(savedViews);

  return (
    <SavedViewsMenu
      orgSlug={savedViews.orgSlug}
      surface="TASKS_BOARD"
      surfaceWorkspaceId={savedViews.workspaceId}
      views={savedViews.views}
      savedViewId={savedViews.savedViewId}
      modified={modified}
      state={state}
      canShare={false}
      canSave={savedViews.canSave}
      extendedActions
      deleteNote="Tasks are not affected."
      onSelect={(view) => {
        // Re-selecting the view already open is "Reset": the URL goes back to the view, and so must the board's column layout
        // (client state that a URL change alone would not touch).
        if (view && view.id === savedViews.savedViewId && savedState && columnLayout) {
          columnLayout.update(() => resolveTaskBoardLayout(savedState.display.columnLayout));
        }
        setAll(view ? new URLSearchParams({ [TASKS_URL_PARAMS.savedView]: view.id }) : new URLSearchParams());
      }}
    />
  );
}
