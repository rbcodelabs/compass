"use client";

import type { ReactNode } from "react";
import { createBoardLayout, type BoardLayoutController, type BoardSavedView } from "@/components/patterns/use-board-layout-store";
import { OPPORTUNITY_BOARD_COLUMN_IDS, OPPORTUNITY_BOARD_LAYOUT_DEFAULTS } from "@/lib/discovery/board-layout";

/**
 * The Opportunities status board's column layout (pinned / dock / order) as client state. The store, its saved-view and
 * localStorage semantics live in components/patterns/use-board-layout-store.tsx; this file only binds it to Discovery.
 * The page wraps the header (saved-views menu, Columns popover) and the board in the provider so they share one layout.
 */

export type OpportunitiesColumnLayoutController = BoardLayoutController;

const opportunitiesLayout = createBoardLayout({
  columnIds: OPPORTUNITY_BOARD_COLUMN_IDS,
  defaults: OPPORTUNITY_BOARD_LAYOUT_DEFAULTS,
  storageKey: (workspaceId) => `compass:discovery-column-layout:${workspaceId}`,
});

export function OpportunitiesColumnLayoutProvider({
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
    <opportunitiesLayout.Provider scopeId={workspaceId} savedView={savedView}>
      {children}
    </opportunitiesLayout.Provider>
  );
}

/** For the saved-views menu: the live layout to save, or null outside a provider (then it saves nothing about layout). */
export const useOpportunitiesColumnLayoutContext = opportunitiesLayout.useContextController;

/** For the board and the Columns popover: the provider's controller, or a standalone localStorage-mirrored store without one. */
export const useOpportunitiesColumnLayout = opportunitiesLayout.useBoardLayout;
