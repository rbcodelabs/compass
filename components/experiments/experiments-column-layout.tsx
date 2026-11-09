"use client";

import { createBoardLayout } from "@/components/patterns/use-board-layout-store";
import { EXPERIMENT_BOARD_LAYOUT_DEFAULTS, EXPERIMENT_BOARD_STATUSES } from "@/lib/experiments/board-layout";

/**
 * The Experiments board's column layout (pinned / dock / order) as client state. The store and its localStorage semantics
 * live in components/patterns/use-board-layout-store.tsx; this file only binds it to Experiments. There is no saved-view
 * provider on this page, so the board uses the standalone mode: the layout is mirrored to this browser's localStorage,
 * one key per workspace, and nowhere else.
 */
export const EXPERIMENTS_LAYOUT_STORAGE_KEY = (workspaceId: string) => `compass:experiments-column-layout:${workspaceId}`;

const experimentsLayout = createBoardLayout({
  columnIds: EXPERIMENT_BOARD_STATUSES,
  defaults: EXPERIMENT_BOARD_LAYOUT_DEFAULTS,
  storageKey: EXPERIMENTS_LAYOUT_STORAGE_KEY,
});

/** For the board: a standalone localStorage-mirrored store (there is no provider on this page). */
export const useExperimentsColumnLayout = experimentsLayout.useBoardLayout;
