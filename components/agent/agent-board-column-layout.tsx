"use client";

import { createBoardLayout } from "@/components/patterns/use-board-layout-store";
import { AGENT_BOARD_COLUMN_IDS, AGENT_BOARD_LAYOUT_DEFAULTS } from "@/lib/agent/board-layout";

/**
 * The Agent board's column layout (pinned / dock / order) as client state, in the store's standalone mode: there is no
 * saved-view provider here, so the layout is mirrored to this browser's localStorage, one key per workspace (the board
 * already reads in the user's own browser, and "reviewed" state is per user, so a workspace key is the right scope).
 */
export const AGENT_BOARD_LAYOUT_STORAGE_KEY = (workspaceId: string) => `compass:agent-board-column-layout:${workspaceId}`;

const agentBoardLayout = createBoardLayout({
  columnIds: AGENT_BOARD_COLUMN_IDS,
  defaults: AGENT_BOARD_LAYOUT_DEFAULTS,
  storageKey: AGENT_BOARD_LAYOUT_STORAGE_KEY,
});

export const useAgentBoardColumnLayout = agentBoardLayout.useBoardLayout;
