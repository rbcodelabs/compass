import { boardFilterKey } from "@/lib/board-filter-key";

/**
 * Identity of the server-side task filter, for use as `TaskBoard`'s React `key`.
 *
 * See lib/board-filter-key.ts for why a board is keyed on its filter inputs at
 * all, and why that is preferred to a signature of the rows the filter returns.
 *
 * `view` is not included — the board/list toggle renders a different component
 * rather than re-filtering this one.
 */
export function taskBoardFilterKey(filters: {
  squad?: string | null;
  assignee?: string | null;
  priority?: string | null;
  /** Custom-field tag filter: the resolved field id and the selected option value. */
  field?: string | null;
  fieldValue?: string | null;
}): string {
  return boardFilterKey([
    filters.squad,
    filters.assignee,
    filters.priority,
    filters.field,
    filters.fieldValue,
  ]);
}
