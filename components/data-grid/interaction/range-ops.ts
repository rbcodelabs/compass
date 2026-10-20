/**
 * Pure planning for multi-cell edits (paste, fill, clear) in sheet mode.
 *
 * A plan is computed from a read-only view of the loaded page and never touches
 * React or the network, so clamping, parsing, skipping and the size limit are
 * unit-testable. The grid then applies the plan through its normal per-cell
 * `commitEdit` path: there is no second write path.
 */

import { parseCellText } from "../cells/cell-values";
import type { GridCellValue, GridEdit, GridRowData } from "../types";
import { rangeCellCount, rangeHeight, type GridRange } from "./range";

/** Most cells one paste, fill or clear may write. Bounds the work per gesture. */
export const DEFAULT_RANGE_OP_LIMIT = 200;

/** Concurrent rows being saved. Cells of one row are always sequential. */
export const RANGE_OP_CONCURRENCY = 3;

/** What the planner needs to know about the loaded page. */
export type PlanGrid<TRow extends GridRowData> = {
  rowCount: number;
  colCount: number;
  rowAt: (row: number) => { id: string; row: TRow } | undefined;
  columnIdAt: (col: number) => string | undefined;
  /** The edit config that applies to this cell now (read-only grids and disabled rows give none). */
  editAt: (row: number, col: number) => GridEdit<TRow> | undefined;
  /** Text of a cell as copied (`format`, or the displayed text). */
  textAt: (row: number, col: number) => string;
};

export type PlannedChange<TRow extends GridRowData> = {
  rowId: string;
  columnId: string;
  rowIndex: number;
  colIndex: number;
  row: TRow;
  edit: GridEdit<TRow>;
  prev: GridCellValue;
  next: GridCellValue;
};

export type PlanParseError = {
  rowId: string;
  columnId: string;
  rowIndex: number;
  colIndex: number;
  error: string;
};

export type RangePlan<TRow extends GridRowData> = {
  changes: PlannedChange<TRow>[];
  /** Cells whose text failed the column's `parse`; they are skipped, never written. */
  parseErrors: PlanParseError[];
  /** Cells in non-editable columns or rows (or any cell in a read-only grid). */
  skippedReadOnly: number;
  /** Cells whose parsed value already equals the current one. */
  unchanged: number;
  /** Set when the pasted block ran past the loaded page. */
  clamped: {
    rows: { received: number; applied: number };
    cols: { received: number; applied: number };
  } | null;
  /** Set when the operation was refused for exceeding the limit; nothing is planned then. */
  overLimit: { cells: number; limit: number } | null;
};

const emptyPlan = <TRow extends GridRowData>(): RangePlan<TRow> => ({
  changes: [],
  parseErrors: [],
  skippedReadOnly: 0,
  unchanged: 0,
  clamped: null,
  overLimit: null,
});

/**
 * Writes `text` (already resolved for the cell) into `plan`: parse through the
 * column, drop no-ops, and count what could not be written.
 */
function planCell<TRow extends GridRowData>(
  plan: RangePlan<TRow>,
  grid: PlanGrid<TRow>,
  row: number,
  col: number,
  text: string,
) {
  const edit = grid.editAt(row, col);
  const target = grid.rowAt(row);
  const columnId = grid.columnIdAt(col);
  if (!edit || !target || columnId === undefined) {
    plan.skippedReadOnly += 1;
    return;
  }
  const parsed = parseCellText(edit, text, target.row);
  if (!parsed.ok) {
    plan.parseErrors.push({
      rowId: target.id,
      columnId,
      rowIndex: row,
      colIndex: col,
      error: parsed.error,
    });
    return;
  }
  const prev = edit.getValue(target.row);
  if (prev === parsed.value) {
    plan.unchanged += 1;
    return;
  }
  plan.changes.push({
    rowId: target.id,
    columnId,
    rowIndex: row,
    colIndex: col,
    row: target.row,
    edit,
    prev,
    next: parsed.value,
  });
}

/**
 * Paste, Sheets rules:
 *  - a 1x1 clipboard fills the whole selected range;
 *  - anything larger is anchored at the range's top-left cell and clamped to the
 *    loaded page (rows) and to the visible columns.
 * More target cells than `limit` refuses the whole paste rather than writing a
 * surprising prefix.
 */
export function planPaste<TRow extends GridRowData>(
  matrix: readonly (readonly string[])[],
  selection: GridRange,
  grid: PlanGrid<TRow>,
  limit = DEFAULT_RANGE_OP_LIMIT,
): RangePlan<TRow> {
  const plan = emptyPlan<TRow>();
  const height = matrix.length;
  const width = matrix.reduce((max, line) => Math.max(max, line.length), 0);
  if (height === 0 || width === 0 || grid.rowCount === 0 || grid.colCount === 0) return plan;

  if (height === 1 && width === 1) {
    const cells = rangeCellCount(selection);
    if (cells > limit) {
      plan.overLimit = { cells, limit };
      return plan;
    }
    for (let row = selection.top; row <= selection.bottom; row += 1) {
      for (let col = selection.left; col <= selection.right; col += 1) {
        planCell(plan, grid, row, col, matrix[0][0]);
      }
    }
    return plan;
  }

  const appliedRows = Math.min(height, grid.rowCount - selection.top);
  const appliedCols = Math.min(width, grid.colCount - selection.left);
  if (appliedRows < height || appliedCols < width) {
    plan.clamped = {
      rows: { received: height, applied: appliedRows },
      cols: { received: width, applied: appliedCols },
    };
  }
  const cells = appliedRows * appliedCols;
  if (cells > limit) {
    plan.overLimit = { cells, limit };
    plan.clamped = null;
    return plan;
  }
  for (let r = 0; r < appliedRows; r += 1) {
    for (let c = 0; c < appliedCols; c += 1) {
      const text = matrix[r][c];
      // A short row has no cell here; leave the target alone rather than clear it.
      if (text === undefined) continue;
      planCell(plan, grid, selection.top + r, selection.left + c, text);
    }
  }
  return plan;
}

/**
 * Fill: every target row takes the text of a source row, cycling through the
 * source rows when the target is taller (the fill handle repeats the selected
 * block, as Sheets does). Ctrl+D is the one-row-source case. No series
 * inference: `1, 2` fills `1, 2, 1, 2`, never `3`.
 */
export function planFill<TRow extends GridRowData>(
  source: GridRange,
  targetRows: { from: number; to: number },
  grid: PlanGrid<TRow>,
  limit = DEFAULT_RANGE_OP_LIMIT,
): RangePlan<TRow> {
  const plan = emptyPlan<TRow>();
  if (targetRows.to < targetRows.from) return plan;
  const target: GridRange = {
    top: targetRows.from,
    bottom: targetRows.to,
    left: source.left,
    right: source.right,
  };
  const cells = rangeCellCount(target);
  if (cells > limit) {
    plan.overLimit = { cells, limit };
    return plan;
  }
  const sourceHeight = rangeHeight(source);
  for (let row = target.top; row <= target.bottom; row += 1) {
    const sourceRow = source.top + (((row - target.top) % sourceHeight) + sourceHeight) % sourceHeight;
    for (let col = target.left; col <= target.right; col += 1) {
      planCell(plan, grid, row, col, grid.textAt(sourceRow, col));
    }
  }
  return plan;
}

/** Clear (Delete / cut): the empty string through each column's `parse`. */
export function planClear<TRow extends GridRowData>(
  range: GridRange,
  grid: PlanGrid<TRow>,
  limit = DEFAULT_RANGE_OP_LIMIT,
): RangePlan<TRow> {
  const plan = emptyPlan<TRow>();
  const cells = rangeCellCount(range);
  if (cells > limit) {
    plan.overLimit = { cells, limit };
    return plan;
  }
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let col = range.left; col <= range.right; col += 1) {
      planCell(plan, grid, row, col, "");
    }
  }
  return plan;
}

// ── Change sets (the unit PR5b's undo/redo will reuse) ──────────────────────

export type GridChangeSource = "paste" | "fill" | "clear" | "cut";

/** One cell's outcome inside a change set. */
export type GridCellChange = {
  rowId: string;
  columnId: string;
  /** The row property the optimistic overlay wrote (`edit.field`). */
  field: string;
  prev: GridCellValue;
  next: GridCellValue;
  /** `saved` once the server accepted it; `failed` cells were rolled back. */
  status: "saved" | "failed";
  error?: string;
};

/**
 * One user gesture. One paste is one change set however many cells it touched,
 * which is exactly the granularity an undo step needs: replay `prev` for the
 * `saved` entries, skipping any whose current value no longer equals `next`.
 */
export type GridChangeSet = {
  id: string;
  source: GridChangeSource;
  at: number;
  changes: GridCellChange[];
};

let changeSetCounter = 0;

/** Wraps a gesture's cell outcomes as one change set. */
export function createChangeSet(
  source: GridChangeSource,
  changes: GridCellChange[],
): GridChangeSet {
  changeSetCounter += 1;
  const at = Date.now();
  return { id: `${source}-${at}-${changeSetCounter}`, source, at, changes };
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Runs `task` for every item with bounded concurrency. Items sharing a `groupKey`
 * run in order (cells of one row are saved one after another to avoid write
 * conflicts on that record); different groups run in parallel up to
 * `concurrency`. Results are returned in input order. `task` must not reject.
 */
export async function runGrouped<T, R>(
  items: readonly T[],
  groupKey: (item: T) => string,
  task: (item: T) => Promise<R>,
  concurrency = RANGE_OP_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = groupKey(item);
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });
  const queue = [...groups.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const index of group) results[index] = await task(items[index]);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** One-line, non-blocking summary of what a plan did not apply. */
export function describePlan<TRow extends GridRowData>(
  plan: RangePlan<TRow>,
  verb: string,
): string | null {
  if (plan.overLimit) {
    return `Can't ${verb} ${plan.overLimit.cells} cells at once. The limit is ${plan.overLimit.limit}; select fewer cells.`;
  }
  const parts: string[] = [];
  if (plan.clamped) {
    const { rows, cols } = plan.clamped;
    if (rows.applied < rows.received) {
      parts.push(`${rows.applied} of ${rows.received} rows pasted: the page ends here`);
    }
    if (cols.applied < cols.received) {
      parts.push(`${cols.applied} of ${cols.received} columns pasted: no more columns`);
    }
  }
  if (plan.skippedReadOnly > 0) {
    parts.push(`${plan.skippedReadOnly} read-only ${plan.skippedReadOnly === 1 ? "cell" : "cells"} skipped`);
  }
  if (plan.parseErrors.length > 0) {
    parts.push(
      `${plan.parseErrors.length} ${plan.parseErrors.length === 1 ? "cell" : "cells"} skipped: ${plan.parseErrors[0].error}`,
    );
  }
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}
