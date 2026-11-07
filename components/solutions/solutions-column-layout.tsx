"use client";

import type { ReactNode } from "react";
import { createBoardLayout, type BoardLayoutController, type BoardSavedView } from "@/components/patterns/use-board-layout-store";
import { SOLUTION_BOARD_COLUMN_IDS, SOLUTION_BOARD_LAYOUT_DEFAULTS } from "@/lib/solutions/board-layout";

/**
 * The Solutions status board's column layout (pinned / dock / order) as client state. The store, its saved-view and
 * localStorage semantics live in components/patterns/use-board-layout-store.tsx; this file only binds it to Solutions.
 * The page wraps the header (saved-views menu, Columns popover) and the board in the provider so they share one layout.
 */

export type SolutionsColumnLayoutController = BoardLayoutController;

const solutionsLayout = createBoardLayout({
  columnIds: SOLUTION_BOARD_COLUMN_IDS,
  defaults: SOLUTION_BOARD_LAYOUT_DEFAULTS,
  storageKey: (workspaceId) => `compass:solutions-column-layout:${workspaceId}`,
});

export function SolutionsColumnLayoutProvider({
  workspaceId,
  savedView,
  children,
}: {
  workspaceId: string;
  /**
   * Where the starting layout comes from: the selected saved view, or an explicit legacy `?order=` link (an id of your
   * choosing). `version` changes when the source does, which resets the layout to `columnLayout`. Null = this browser's own.
   */
  savedView: BoardSavedView | null;
  children: ReactNode;
}) {
  return (
    <solutionsLayout.Provider scopeId={workspaceId} savedView={savedView}>
      {children}
    </solutionsLayout.Provider>
  );
}

/** For the saved-views menu: the live layout to save, or null outside a provider (then it saves nothing about layout). */
export const useSolutionsColumnLayoutContext = solutionsLayout.useContextController;

/** For the board and the Columns popover: the provider's controller, or a standalone localStorage-mirrored store without one. */
export const useSolutionsColumnLayout = solutionsLayout.useBoardLayout;
