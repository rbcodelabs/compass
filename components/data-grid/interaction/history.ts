/**
 * Undo / redo over change sets. Pure: no React, no network.
 *
 * One change set (one paste, fill, clear or edit) is one history step. Undoing a
 * step replays each cell's `prev` through the column's normal save path, but
 * only where the cell still holds what the step wrote (`next`). A cell that
 * changed since (another user, the server, a later edit) is skipped and
 * reported rather than overwritten.
 *
 * Redo is the same operation on the inverse set: undoing step S produces the
 * inverse S' (prev/next swapped, only for cells that were actually replayed),
 * and "undo S'" re-applies S. So there is exactly one replay rule to get right.
 *
 * Creates never enter history: the draft area is a separate path and undoing a
 * create would be a delete.
 */

import type { GridCellValue } from "../types";
import {
  createChangeSet,
  type GridCellChange,
  type GridChangeSet,
} from "./range-ops";

/** Steps kept per grid. A bound on memory, far above what a session needs. */
export const HISTORY_LIMIT = 100;

export type GridHistory = {
  /** Oldest first; the last entry is the next undo. */
  undo: readonly GridChangeSet[];
  /** Oldest first; the last entry is the next redo. */
  redo: readonly GridChangeSet[];
};

export const EMPTY_HISTORY: GridHistory = Object.freeze({ undo: [], redo: [] });

export type HistoryDirection = "undo" | "redo";

/** Only cells the server accepted can be reverted; failed cells were rolled back. */
const savedOnly = (set: GridChangeSet): GridChangeSet =>
  set.changes.every((change) => change.status === "saved")
    ? set
    : { ...set, changes: set.changes.filter((change) => change.status === "saved") };

/**
 * Records a finished gesture. A set with no saved cell is not a step. A new
 * step invalidates redo: the redo stack described a future that no longer follows.
 */
export function recordChangeSet(
  history: GridHistory,
  set: GridChangeSet,
  limit = HISTORY_LIMIT,
): GridHistory {
  const saved = savedOnly(set);
  if (saved.changes.length === 0) return history;
  const undo = [...history.undo, saved];
  return { undo: undo.length > limit ? undo.slice(undo.length - limit) : undo, redo: [] };
}

/** Takes the next step off a stack. The caller replays it, then calls `finishRevert`. */
export function takeStep(
  history: GridHistory,
  direction: HistoryDirection,
): { step: GridChangeSet; rest: GridHistory } | null {
  const stack = direction === "undo" ? history.undo : history.redo;
  const step = stack.at(-1);
  if (!step) return null;
  const remaining = stack.slice(0, -1);
  return {
    step,
    rest: direction === "undo" ? { ...history, undo: remaining } : { ...history, redo: remaining },
  };
}

/**
 * Files the inverse on the opposite stack (no redo invalidation: this is the
 * history moving, not a new edit). `inverseSet` null means nothing was replayed,
 * so the step is simply dropped.
 */
export function finishRevert(
  history: GridHistory,
  direction: HistoryDirection,
  inverseSet: GridChangeSet | null,
  limit = HISTORY_LIMIT,
): GridHistory {
  const saved = inverseSet ? savedOnly(inverseSet) : null;
  if (!saved || saved.changes.length === 0) return history;
  if (direction === "undo") {
    const redo = [...history.redo, saved];
    return { ...history, redo: redo.length > limit ? redo.slice(redo.length - limit) : redo };
  }
  const undo = [...history.undo, saved];
  return { ...history, undo: undo.length > limit ? undo.slice(undo.length - limit) : undo };
}

export type CurrentCell =
  | { found: true; value: GridCellValue }
  /** The row is not on the loaded page, or the column is gone / not editable. */
  | { found: false; reason: "missing" | "readonly" };

export type RevertSkip = {
  change: GridCellChange;
  reason: "changed" | "missing" | "readonly";
};

export type RevertPlan = {
  /** Cells to write: each goes back to its `prev`. */
  replay: GridCellChange[];
  skipped: RevertSkip[];
};

/**
 * The conflict rule. A cell is replayed only if its current value equals what
 * the step wrote (`next`); anything else is skipped and reported.
 */
export function planRevert(
  step: GridChangeSet,
  currentOf: (change: GridCellChange) => CurrentCell,
): RevertPlan {
  const replay: GridCellChange[] = [];
  const skipped: RevertSkip[] = [];
  for (const change of step.changes) {
    const current = currentOf(change);
    if (!current.found) skipped.push({ change, reason: current.reason });
    else if (current.value !== change.next) skipped.push({ change, reason: "changed" });
    else replay.push(change);
  }
  return { replay, skipped };
}

/** The set recording what a revert actually wrote: the opposite stack's entry. */
export function inverseChangeSet(
  direction: HistoryDirection,
  outcomes: readonly { change: GridCellChange; status: "saved" | "failed"; error?: string }[],
): GridChangeSet {
  return createChangeSet(
    direction,
    outcomes.map(({ change, status, error }) => ({
      rowId: change.rowId,
      columnId: change.columnId,
      field: change.field,
      prev: change.next,
      next: change.prev,
      status,
      error,
    })),
  );
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** One-line report for the live region and the notice strip. */
export function describeRevert(
  direction: HistoryDirection,
  counts: { restored: number; failed: number; skipped: readonly RevertSkip[] },
): string {
  const verb = direction === "undo" ? "Undid" : "Redid";
  const { restored, failed, skipped } = counts;
  const parts = [`${verb} ${restored} ${plural(restored, "cell", "cells")}`];
  if (failed > 0) parts.push(`${failed} could not be saved`);
  const changed = skipped.filter((skip) => skip.reason === "changed").length;
  const missing = skipped.filter((skip) => skip.reason === "missing").length;
  const readonly = skipped.filter((skip) => skip.reason === "readonly").length;
  if (changed > 0) {
    parts.push(
      `${changed} ${plural(changed, "cell was", "cells were")} skipped because ${plural(changed, "it", "they")} changed since`,
    );
  }
  if (missing > 0) {
    parts.push(`${missing} ${plural(missing, "cell was", "cells were")} skipped: ${plural(missing, "its row is", "their rows are")} no longer on this page`);
  }
  if (readonly > 0) {
    parts.push(`${readonly} read-only ${plural(readonly, "cell was", "cells were")} skipped`);
  }
  return `${parts.join("; ")}.`;
}
