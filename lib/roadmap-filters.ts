import { boardFilterKey } from "@/lib/board-filter-key";

/**
 * Identity of the server-side roadmap filter, for use as the React `key` of
 * both roadmap views — `RoadmapBoard` and `NativeTimeline`.
 *
 * See lib/board-filter-key.ts for why a board is keyed on its filter inputs at
 * all. Both views seed their columns/lanes from `useState` and never re-sync,
 * so each needs the key for a filter change to be visible; sharing one helper
 * is what keeps Board and Timeline from disagreeing about when to resync.
 *
 * `workspaceId` is part of the identity because the rest of the facets are
 * workspace-relative ids — it can only change together with the route, but
 * including it means a key can never be reused across workspaces.
 *
 * `view` is not included — the board/timeline toggle renders a different
 * component rather than re-filtering one of them.
 */
export function roadmapBoardFilterKey(filters: {
  workspaceId: string;
  squad?: string | null;
  /** Custom-field tag filter: the resolved field id and the selected option value. */
  field?: string | null;
  fieldValue?: string | null;
}): string {
  return boardFilterKey([
    filters.workspaceId,
    filters.squad,
    filters.field,
    filters.fieldValue,
  ]);
}
