import { describe, expect, it } from "vitest";

import {
  nextPosition,
  resolveGridKey,
  type GridDimensions,
} from "@/components/data-grid/interaction/grid-keymap";
import {
  INITIAL_GRID_INTERACTION,
  gridInteractionReducer,
  resolveActiveCell,
  type GridInteractionState,
} from "@/components/data-grid/interaction/use-grid-interaction";

describe("resolveGridKey (nav mode)", () => {
  it.each([
    ["ArrowUp", { type: "move", rows: -1, cols: 0 }],
    ["ArrowDown", { type: "move", rows: 1, cols: 0 }],
    ["ArrowLeft", { type: "move", rows: 0, cols: -1 }],
    ["ArrowRight", { type: "move", rows: 0, cols: 1 }],
    ["Enter", { type: "startEdit" }],
    ["F2", { type: "startEdit" }],
    ["Delete", { type: "clear" }],
    ["Backspace", { type: "clear" }],
    ["PageDown", { type: "page", direction: 1 }],
    ["Home", { type: "moveTo", target: "rowStart" }],
    ["End", { type: "moveTo", target: "rowEnd" }],
  ])("%s", (key, expected) => {
    expect(resolveGridKey({ key }, "nav")).toEqual(expected);
  });

  it("Alt+Enter opens the detail panel instead of editing", () => {
    expect(resolveGridKey({ key: "Enter", altKey: true }, "nav")).toEqual({
      type: "openDetail",
    });
  });

  it("Tab and Shift+Tab travel in opposite directions", () => {
    expect(resolveGridKey({ key: "Tab" }, "nav")).toEqual({ type: "tab", direction: 1 });
    expect(resolveGridKey({ key: "Tab", shiftKey: true }, "nav")).toEqual({
      type: "tab",
      direction: -1,
    });
  });

  it("Ctrl+Home / Ctrl+End jump to the grid corners", () => {
    expect(resolveGridKey({ key: "Home", ctrlKey: true }, "nav")).toEqual({
      type: "moveTo",
      target: "gridStart",
    });
    expect(resolveGridKey({ key: "End", metaKey: true }, "nav")).toEqual({
      type: "moveTo",
      target: "gridEnd",
    });
  });

  it("a printable character starts an edit that replaces the content", () => {
    expect(resolveGridKey({ key: "x" }, "nav")).toEqual({ type: "startEdit", text: "x" });
    expect(resolveGridKey({ key: "X", shiftKey: true }, "nav")).toEqual({
      type: "startEdit",
      text: "X",
    });
  });

  it("leaves browser shortcuts and named keys alone", () => {
    expect(resolveGridKey({ key: "r", ctrlKey: true }, "nav")).toBeNull();
    expect(resolveGridKey({ key: "k", metaKey: true }, "nav")).toBeNull();
    expect(resolveGridKey({ key: "Shift" }, "nav")).toBeNull();
    expect(resolveGridKey({ key: "F5" }, "nav")).toBeNull();
    expect(resolveGridKey({ key: "Escape" }, "nav")).toBeNull();
  });
});

describe("resolveGridKey (edit mode)", () => {
  it("Enter commits and moves down; Shift+Enter moves up", () => {
    expect(resolveGridKey({ key: "Enter" }, "edit")).toEqual({ type: "commit", move: "down" });
    expect(resolveGridKey({ key: "Enter", shiftKey: true }, "edit")).toEqual({
      type: "commit",
      move: "up",
    });
  });

  it("Tab commits and moves sideways", () => {
    expect(resolveGridKey({ key: "Tab" }, "edit")).toEqual({ type: "commit", move: "right" });
    expect(resolveGridKey({ key: "Tab", shiftKey: true }, "edit")).toEqual({
      type: "commit",
      move: "left",
    });
  });

  it("Escape cancels", () => {
    expect(resolveGridKey({ key: "Escape" }, "edit")).toEqual({ type: "cancel" });
  });

  it("arrows and characters are left to the editor", () => {
    expect(resolveGridKey({ key: "ArrowLeft" }, "edit")).toBeNull();
    expect(resolveGridKey({ key: "a" }, "edit")).toBeNull();
  });
});

describe("nextPosition", () => {
  const grid = (editableCols: number[], rows = 3, cols = 4): GridDimensions => ({
    rowCount: rows,
    colCount: cols,
    isEditable: (_r, c) => editableCols.includes(c),
    pageSize: 2,
  });

  it("clamps arrow movement at the edges", () => {
    const g = grid([0]);
    expect(nextPosition({ row: 0, col: 0 }, { type: "move", rows: -1, cols: -1 }, g)).toEqual({
      row: 0,
      col: 0,
    });
    expect(nextPosition({ row: 2, col: 3 }, { type: "move", rows: 1, cols: 1 }, g)).toEqual({
      row: 2,
      col: 3,
    });
  });

  it("Tab skips non-editable cells and wraps to the next row", () => {
    const g = grid([0, 2]);
    expect(nextPosition({ row: 0, col: 0 }, { type: "tab", direction: 1 }, g)).toEqual({
      row: 0,
      col: 2,
    });
    expect(nextPosition({ row: 0, col: 2 }, { type: "tab", direction: 1 }, g)).toEqual({
      row: 1,
      col: 0,
    });
    expect(nextPosition({ row: 1, col: 0 }, { type: "tab", direction: -1 }, g)).toEqual({
      row: 0,
      col: 2,
    });
  });

  it("Tab past the last editable cell returns null so focus can leave the grid", () => {
    const g = grid([0, 2]);
    expect(nextPosition({ row: 2, col: 2 }, { type: "tab", direction: 1 }, g)).toBeNull();
    expect(nextPosition({ row: 0, col: 0 }, { type: "tab", direction: -1 }, g)).toBeNull();
  });

  it("pages by pageSize and clamps; Home/End/Ctrl variants hit the edges", () => {
    const g = grid([0], 5);
    expect(nextPosition({ row: 0, col: 1 }, { type: "page", direction: 1 }, g)).toEqual({
      row: 2,
      col: 1,
    });
    expect(nextPosition({ row: 4, col: 1 }, { type: "page", direction: 1 }, g)).toEqual({
      row: 4,
      col: 1,
    });
    expect(nextPosition({ row: 3, col: 1 }, { type: "moveTo", target: "rowEnd" }, g)).toEqual({
      row: 3,
      col: 3,
    });
    expect(nextPosition({ row: 3, col: 1 }, { type: "moveTo", target: "gridStart" }, g)).toEqual({
      row: 0,
      col: 0,
    });
  });
});

describe("gridInteractionReducer", () => {
  const cell = { rowId: "r1", columnId: "title" };
  const active: GridInteractionState = {
    ...INITIAL_GRID_INTERACTION,
    active: cell,
  };

  it("pointer activation does not request DOM focus", () => {
    const next = gridInteractionReducer(INITIAL_GRID_INTERACTION, {
      type: "activate",
      cell,
      rowIndex: 0,
    });
    expect(next.active).toEqual(cell);
    expect(next.focusSeq).toBe(0);
  });

  it("keyboard moves request DOM focus and reset to nav mode", () => {
    const editing = gridInteractionReducer(active, { type: "startEdit", text: "a" });
    const next = gridInteractionReducer(editing, {
      type: "focusCell",
      cell: { rowId: "r2", columnId: "title" },
      rowIndex: 1,
    });
    expect(next.mode).toBe("nav");
    expect(next.focusSeq).toBe(1);
  });

  it("re-activating the same cell keeps the open editor", () => {
    const editing = gridInteractionReducer(active, { type: "startEdit", text: "a" });
    expect(gridInteractionReducer(editing, { type: "activate", cell, rowIndex: 0 })).toBe(
      editing,
    );
  });

  it("startEdit needs an active cell; endEdit clears the draft", () => {
    expect(
      gridInteractionReducer(INITIAL_GRID_INTERACTION, { type: "startEdit", text: "a" }),
    ).toBe(INITIAL_GRID_INTERACTION);
    const editing = gridInteractionReducer(active, { type: "startEdit", text: "abc" });
    expect(editing.mode).toBe("edit");
    const done = gridInteractionReducer(editing, { type: "endEdit", refocus: true });
    expect(done).toMatchObject({ mode: "nav", draftText: "", focusSeq: 1 });
  });

  it("a parse error keeps the editor open and typing clears it", () => {
    const editing = gridInteractionReducer(active, { type: "startEdit", text: "x" });
    const errored = gridInteractionReducer(editing, { type: "setEditError", error: "Nope" });
    expect(errored.editError).toBe("Nope");
    expect(gridInteractionReducer(errored, { type: "setDraft", text: "y" }).editError).toBeNull();
  });
});

describe("resolveActiveCell", () => {
  const cols = ["title", "status"];

  it("defaults to the first cell so exactly one cell is always a tab stop", () => {
    expect(
      resolveActiveCell(INITIAL_GRID_INTERACTION, ["a", "b"], cols),
    ).toEqual({ row: 0, col: 0 });
  });

  it("follows the row id, not its index, when rows reorder", () => {
    const state = { active: { rowId: "b", columnId: "status" }, rowIndexHint: 1 };
    expect(resolveActiveCell(state, ["b", "a"], cols)).toEqual({ row: 0, col: 1 });
  });

  it("falls back to the nearest surviving index when the active row disappears", () => {
    const state = { active: { rowId: "gone", columnId: "title" }, rowIndexHint: 5 };
    expect(resolveActiveCell(state, ["a", "b", "c"], cols)).toEqual({ row: 2, col: 0 });
  });

  it("returns null for an empty grid", () => {
    expect(resolveActiveCell(INITIAL_GRID_INTERACTION, [], cols)).toBeNull();
  });
});
