/**
 * Pure range math for sheet-mode selection. A range is the rectangle between
 * two corners over (rowIndex, colIndex) of the visible, non-selection columns
 * of the loaded page; nothing here knows about the DOM or React.
 */

import type { GridPosition } from "./grid-keymap";

/** Inclusive rectangle. `top <= bottom` and `left <= right` always hold. */
export type GridRange = { top: number; left: number; bottom: number; right: number };

export function normalizeRange(a: GridPosition, b: GridPosition): GridRange {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
}

export const rangeHeight = (range: GridRange) => range.bottom - range.top + 1;
export const rangeWidth = (range: GridRange) => range.right - range.left + 1;
export const rangeCellCount = (range: GridRange) => rangeHeight(range) * rangeWidth(range);
export const isSingleCell = (range: GridRange) => rangeCellCount(range) === 1;

export function rangeContains(range: GridRange, row: number, col: number): boolean {
  return (
    row >= range.top && row <= range.bottom && col >= range.left && col <= range.right
  );
}

/** Moves one corner by a delta, clamped to the page. */
export function moveCorner(
  corner: GridPosition,
  delta: { rows: number; cols: number },
  bounds: { rowCount: number; colCount: number },
): GridPosition {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(0, max));
  return {
    row: clamp(corner.row + delta.rows, bounds.rowCount - 1),
    col: clamp(corner.col + delta.cols, bounds.colCount - 1),
  };
}

/**
 * The range for a state: the anchor (active cell) to the moving corner. With no
 * moving corner the "range" is the active cell alone, so copy, paste and fill
 * share one code path whether or not the user dragged.
 */
export function selectionRange(anchor: GridPosition, end: GridPosition | null): GridRange {
  return normalizeRange(anchor, end ?? anchor);
}
