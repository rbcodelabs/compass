/**
 * Identity of the server-side task filter, for use as `TaskBoard`'s React `key`.
 *
 * `TaskBoard` keeps its columns in client state so drag-and-drop can move cards
 * optimistically. Changing a filter pushes a new URL and the server re-renders
 * the page with a correctly narrowed task set, but React reconciles the same
 * client instance — so without something forcing a remount the board keeps
 * painting the pre-filter cards while the URL says otherwise.
 *
 * Keying the board on the filter values remounts it on, and only on, a filter
 * change. That is exactly the moment optimistic client state *should* be
 * discarded in favour of server truth, and it leaves every other re-render
 * alone: revalidation after a drag, a create or a cancel carries an unchanged
 * key, so the client's optimistic state is never clobbered.
 *
 * Deliberately keyed on the filter inputs rather than on the resulting task set
 * (e.g. a signature of the returned ids). A task-set signature is only a proxy
 * for "the filter changed", and it is wrong in both directions: any unrelated
 * create or delete landing via revalidation also changes the id set and would
 * discard a pending optimistic reorder, while a filter that happens to return
 * the same ids would not resync at all.
 *
 * `view` is not included — the board/list toggle renders a different component
 * rather than re-filtering this one.
 */
export function taskBoardFilterKey(filters: {
  squad?: string | null;
  assignee?: string | null;
  priority?: string | null;
}): string {
  return [filters.squad ?? "", filters.assignee ?? "", filters.priority ?? ""].join("|");
}
