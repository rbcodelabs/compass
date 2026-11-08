"use client";

import type { ReactNode } from "react";
import { createBoardLayout, type BoardLayoutController, type BoardSavedView } from "@/components/patterns/use-board-layout-store";
import { ROADMAP_BOARD_COLUMN_IDS, ROADMAP_BOARD_LAYOUT_DEFAULTS } from "@/lib/roadmap/board-layout";

/**
 * The workspace roadmap's column layout (pinned / collapsed / order) as client state. The store, its saved-view and
 * localStorage semantics live in components/patterns/use-board-layout-store.tsx; this file only binds it to the roadmap.
 */

export type ColumnLayoutController = BoardLayoutController;

const roadmapLayout = createBoardLayout({
  columnIds: ROADMAP_BOARD_COLUMN_IDS,
  defaults: ROADMAP_BOARD_LAYOUT_DEFAULTS,
  storageKey: (workspaceId) => `compass:roadmap-column-layout:${workspaceId}`,
});

export function RoadmapColumnLayoutProvider({
  workspaceId,
  savedView,
  children,
}: {
  workspaceId: string;
  /** The selected saved view, if any. `version` changes when the view is saved, which resets the layout to what was saved. */
  savedView: BoardSavedView | null;
  children: ReactNode;
}) {
  return (
    <roadmapLayout.Provider scopeId={workspaceId} savedView={savedView}>
      {children}
    </roadmapLayout.Provider>
  );
}

/** For the saved-views menu: the live layout to save, or null outside a provider (then it saves nothing about layout). */
export const useRoadmapColumnLayoutContext = roadmapLayout.useContextController;

/** For the board: the provider's controller, or a standalone localStorage-mirrored store when rendered without one. */
export const useRoadmapColumnLayout = roadmapLayout.useBoardLayout;
