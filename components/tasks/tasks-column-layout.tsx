"use client";

import type { ReactNode } from "react";
import { createBoardLayout, type BoardLayoutController, type BoardSavedView } from "@/components/patterns/use-board-layout-store";
import { TASK_BOARD_COLUMN_IDS, TASK_BOARD_LAYOUT_DEFAULTS } from "@/lib/tasks/board-layout";

/**
 * The Tasks board's column layout (pinned / dock / order) as client state. The store, its saved-view and localStorage
 * semantics live in components/patterns/use-board-layout-store.tsx; this file only binds it to Tasks. The page wraps the
 * header (saved-views menu) and the board in the provider so they share one layout.
 */

export type TasksColumnLayoutController = BoardLayoutController;

const tasksLayout = createBoardLayout({
  columnIds: TASK_BOARD_COLUMN_IDS,
  defaults: TASK_BOARD_LAYOUT_DEFAULTS,
  storageKey: (workspaceId) => `compass:tasks-column-layout:${workspaceId}`,
});

export function TasksColumnLayoutProvider({
  workspaceId,
  savedView,
  children,
}: {
  workspaceId: string;
  /** The selected saved view (its stored layout is the starting layout; `version` changes when it is saved). Null = this browser's own. */
  savedView: BoardSavedView | null;
  children: ReactNode;
}) {
  return (
    <tasksLayout.Provider scopeId={workspaceId} savedView={savedView}>
      {children}
    </tasksLayout.Provider>
  );
}

/** For the saved-views menu: the live layout to save, or null outside a provider (then it saves nothing about layout). */
export const useTasksColumnLayoutContext = tasksLayout.useContextController;

/** For the board: the provider's controller, or a standalone localStorage-mirrored store without one. */
export const useTasksColumnLayout = tasksLayout.useBoardLayout;
