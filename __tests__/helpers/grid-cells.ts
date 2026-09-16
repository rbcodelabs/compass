import { expect } from "vitest";

/**
 * Shared assertion for the DataGrid's column-overflow contract.
 *
 * The grid renders `table-fixed` and `components/ui/table.tsx`'s TableCell is
 * `whitespace-nowrap`, so a column's declared width is hard and its content
 * cannot wrap. Content wider than the column therefore escapes the cell box and
 * paints over the next column unless the cell clips it — which is how
 * "Sample Workspace Admin" in the 9rem Tasks Assignee column ended up painting
 * over Squad's "Core Product".
 *
 * That is a property of the grid, not of any one column, so it is asserted over
 * *every* rendered cell rather than column by column: a column added later
 * inherits the guarantee and inherits this test with it.
 *
 * jsdom has no layout engine, so this asserts the mechanism (the clip class the
 * grid applies) rather than measured geometry. The geometry itself is verified
 * in a real browser — see the QA note for this change.
 */

/**
 * Columns that are deliberately NOT clipped:
 *
 *  - `__select` holds a checkbox whose `after:-inset-x-3` hit target extends
 *    12px outside its box into a cell with `pr-0`; clipping it would shrink a
 *    real pointer target.
 *  - `__mobile` is the full-width stacked card, which wraps instead of
 *    nowrapping and must be free to be as tall as its content.
 */
const UNCLIPPED_COLUMNS = new Set(["__select", "__mobile"]);

/** Tailwind's clip pair. `truncate` would also re-assert `whitespace-nowrap`. */
export const GRID_CELL_CLIP_CLASS = "overflow-hidden";

/**
 * Fails with the list of offending column ids, so a regression names the column
 * that leaks rather than just reporting a boolean.
 */
export function expectEveryGridCellClipped(container: HTMLElement): void {
  // `td[data-col]`, not `[data-testid^="grid-cell-"]`: the latter also matches
  // the EditableCell trigger (`grid-cell-edit`), which is a button inside a
  // cell rather than a cell.
  const cells = Array.from(
    container.querySelectorAll<HTMLElement>("td[data-col]"),
  ).filter((cell) => !UNCLIPPED_COLUMNS.has(cell.dataset.col ?? ""));

  // A grid that rendered no cells would pass vacuously.
  expect(cells.length).toBeGreaterThan(0);

  const leaking = [
    ...new Set(
      cells
        .filter((cell) => !cell.classList.contains(GRID_CELL_CLIP_CLASS))
        .map((cell) => cell.dataset.col ?? "(unknown column)"),
    ),
  ];

  expect(leaking).toEqual([]);
}
