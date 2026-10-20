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
  active: GridCellId | null;
  rowIndexHint: number;
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
  | { type: "startEdit"; text: string }
  | { type: "setDraft"; text: string }
  | { type: "setEditError"; error: string | null }
  | { type: "endEdit"; refocus: boolean };

export const INITIAL_GRID_INTERACTION: GridInteractionState = {
  active: null,
  rowIndexHint: 0,
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
        mode: "nav",
        draftText: "",
        editError: null,
      };
    }
    case "focusCell":
      return {
        ...state,
        active: action.cell,
        rowIndexHint: action.rowIndex,
        mode: "nav",
        draftText: "",
        editError: null,
        focusSeq: state.focusSeq + 1,
      };
    case "startEdit":
      if (!state.active) return state;
      return { ...state, mode: "edit", draftText: action.text, editError: null };
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
