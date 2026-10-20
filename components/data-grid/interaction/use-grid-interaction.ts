import * as React from "react";

import type { GridMode } from "./grid-keymap";

/**
 * Focus identity is `(rowId, columnId)`, never an index: the page re-renders
 * when a server action revalidates and re-delivers `rows`, and an index would
 * silently move focus to a different record. `rowIndexHint` exists only to pick
 * the nearest surviving row when the active one disappears.
 */
export type GridCellId = { rowId: string; columnId: string };

export type GridInteractionState = {
  /** The active cell, which is also the range's anchor: it stays put while the range grows. */
  active: GridCellId | null;
  rowIndexHint: number;
  /**
   * The moving corner of a multi-cell range, or null when only the active cell
   * is selected. Keyed by id like `active`, so a re-delivery cannot slide the
   * range onto different records.
   */
  rangeEnd: GridCellId | null;
  /** Last row index of an in-progress fill-handle drag, for the preview. */
  fillTo: number | null;
  mode: GridMode;
  /** Text in the open editor (text-like kinds). */
  draftText: string;
  /** Validation message from the last failed commit of the open editor. */
  editError: string | null;
  /**
   * Incremented whenever DOM focus must be moved to the active cell. Pointer
   * activation does not bump it (the browser already focused the cell), and
   * neither does an RSC re-delivery, so focus is never stolen.
   */
  focusSeq: number;
};

export type GridInteractionAction =
  | { type: "activate"; cell: GridCellId; rowIndex: number }
  | { type: "focusCell"; cell: GridCellId; rowIndex: number }
  /** Pointer down on a cell: it becomes the active cell and any range collapses. */
  | { type: "beginPointer"; cell: GridCellId; rowIndex: number }
  | { type: "extendRange"; cell: GridCellId }
  | { type: "collapseRange" }
  | { type: "setFillPreview"; rowIndex: number | null }
  | { type: "startEdit"; text: string }
  | { type: "setDraft"; text: string }
  | { type: "setEditError"; error: string | null }
  | { type: "endEdit"; refocus: boolean };

export const INITIAL_GRID_INTERACTION: GridInteractionState = {
  active: null,
  rowIndexHint: 0,
  rangeEnd: null,
  fillTo: null,
  mode: "nav",
  draftText: "",
  editError: null,
  focusSeq: 0,
};

const sameCell = (a: GridCellId | null, b: GridCellId) =>
  Boolean(a) && a!.rowId === b.rowId && a!.columnId === b.columnId;

export function gridInteractionReducer(
  state: GridInteractionState,
  action: GridInteractionAction,
): GridInteractionState {
  switch (action.type) {
    case "activate": {
      // Re-activating the cell that is already active (a click inside its open
      // editor) must not drop out of edit mode.
      if (sameCell(state.active, action.cell)) {
        return state.rowIndexHint === action.rowIndex
          ? state
          : { ...state, rowIndexHint: action.rowIndex };
      }
      return {
        ...state,
        active: action.cell,
        rowIndexHint: action.rowIndex,
        rangeEnd: null,
        fillTo: null,
        mode: "nav",
        draftText: "",
        editError: null,
      };
    }
    case "beginPointer":
      // A press inside the open editor is the user placing the caret.
      if (sameCell(state.active, action.cell) && state.mode === "edit") return state;
      return {
        ...state,
        active: action.cell,
        rowIndexHint: action.rowIndex,
        rangeEnd: null,
        fillTo: null,
        mode: "nav",
        draftText: "",
        editError: null,
      };
    case "extendRange":
      if (!state.active || state.mode === "edit") return state;
      if (sameCell(state.rangeEnd, action.cell)) return state;
      // Extending back onto the anchor is the same as having no range.
      return {
        ...state,
        rangeEnd: sameCell(state.active, action.cell) ? null : action.cell,
      };
    case "collapseRange":
      return state.rangeEnd || state.fillTo !== null
        ? { ...state, rangeEnd: null, fillTo: null }
        : state;
    case "setFillPreview":
      return state.fillTo === action.rowIndex ? state : { ...state, fillTo: action.rowIndex };
    case "focusCell":
      return {
        ...state,
        active: action.cell,
        rowIndexHint: action.rowIndex,
        rangeEnd: null,
        fillTo: null,
        mode: "nav",
        draftText: "",
        editError: null,
        focusSeq: state.focusSeq + 1,
      };
    case "startEdit":
      if (!state.active) return state;
      return {
        ...state,
        mode: "edit",
        rangeEnd: null,
        fillTo: null,
        draftText: action.text,
        editError: null,
      };
    case "setDraft":
      return state.mode === "edit"
        ? { ...state, draftText: action.text, editError: null }
        : state;
    case "setEditError":
      return state.mode === "edit" ? { ...state, editError: action.error } : state;
    case "endEdit":
      return {
        ...state,
        mode: "nav",
        draftText: "",
        editError: null,
        focusSeq: action.refocus ? state.focusSeq + 1 : state.focusSeq,
      };
  }
}

export function useGridInteraction() {
  return React.useReducer(gridInteractionReducer, INITIAL_GRID_INTERACTION);
}

/**
 * Resolves the active cell against the rows and columns that exist NOW. A stale
 * row id (filtered out, then refreshed) falls back to the nearest surviving
 * index; a stale-but-present row keeps focus where it is.
 */
export function resolveActiveCell(
  state: Pick<GridInteractionState, "active" | "rowIndexHint">,
  rowIds: readonly string[],
  columnIds: readonly string[],
): { row: number; col: number } | null {
  if (rowIds.length === 0 || columnIds.length === 0) return null;
  if (!state.active) return { row: 0, col: 0 };

  let row = rowIds.indexOf(state.active.rowId);
  if (row < 0) row = Math.min(Math.max(0, state.rowIndexHint), rowIds.length - 1);
  let col = columnIds.indexOf(state.active.columnId);
  if (col < 0) col = 0;
  return { row, col };
}

/**
 * Resolves the range's moving corner against the rows and columns that exist
 * now. A corner whose row or column has vanished (a re-delivery) drops the
 * range instead of guessing a new extent.
 */
export function resolveRangeEnd(
  state: Pick<GridInteractionState, "rangeEnd">,
  rowIds: readonly string[],
  columnIds: readonly string[],
): { row: number; col: number } | null {
  if (!state.rangeEnd) return null;
  const row = rowIds.indexOf(state.rangeEnd.rowId);
  const col = columnIds.indexOf(state.rangeEnd.columnId);
  return row < 0 || col < 0 ? null : { row, col };
}
