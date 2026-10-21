import { describe, expect, it } from "vitest";

import { formatTsv, parseTsv, rangeToMatrix } from "@/components/data-grid/clipboard";
import { resolveGridKey } from "@/components/data-grid/interaction/grid-keymap";
import {
  isSingleCell,
  moveCorner,
  normalizeRange,
  rangeCellCount,
  rangeContains,
  selectionRange,
} from "@/components/data-grid/interaction/range";
import {
  createChangeSet,
  describePlan,
  planClear,
  planFill,
  planPaste,
  runGrouped,
  type PlanGrid,
} from "@/components/data-grid/interaction/range-ops";
import {
  gridInteractionReducer,
  INITIAL_GRID_INTERACTION,
  resolveRangeEnd,
} from "@/components/data-grid/interaction/use-grid-interaction";
import type { GridEdit } from "@/components/data-grid/types";

describe("range math", () => {
  it("normalizes corners in any direction", () => {
    expect(normalizeRange({ row: 3, col: 2 }, { row: 1, col: 4 })).toEqual({
      top: 1,
      bottom: 3,
      left: 2,
      right: 4,
    });
  });

  it("counts, contains and detects a single cell", () => {
    const range = normalizeRange({ row: 1, col: 1 }, { row: 2, col: 3 });
    expect(rangeCellCount(range)).toBe(6);
    expect(rangeContains(range, 2, 3)).toBe(true);
    expect(rangeContains(range, 0, 1)).toBe(false);
    expect(rangeContains(range, 1, 4)).toBe(false);
    expect(isSingleCell(normalizeRange({ row: 2, col: 2 }, { row: 2, col: 2 }))).toBe(true);
    expect(isSingleCell(range)).toBe(false);
  });

  it("moves a corner clamped to the page", () => {
    const bounds = { rowCount: 4, colCount: 3 };
    expect(moveCorner({ row: 3, col: 2 }, { rows: 1, cols: 1 }, bounds)).toEqual({ row: 3, col: 2 });
    expect(moveCorner({ row: 0, col: 0 }, { rows: -1, cols: -1 }, bounds)).toEqual({ row: 0, col: 0 });
    expect(moveCorner({ row: 1, col: 1 }, { rows: 1, cols: 0 }, bounds)).toEqual({ row: 2, col: 1 });
  });

  it("is the active cell alone when there is no moving corner", () => {
    expect(selectionRange({ row: 2, col: 1 }, null)).toEqual({ top: 2, bottom: 2, left: 1, right: 1 });
  });
});

describe("formatTsv / rangeToMatrix", () => {
  it("quotes tabs, newlines and quotes and doubles quotes", () => {
    expect(formatTsv([["a", "b\tc", 'say "hi"', "x\ny"]])).toBe('a\t"b\tc"\t"say ""hi"""\t"x\ny"');
  });

  it("round-trips through parseTsv, including awkward cells", () => {
    const matrix = [
      ["plain", "with\ttab", 'with "quote"'],
      ["multi\nline", "", "trailing space "],
      ["=1+1", "  ", "“smart”"],
    ];
    expect(parseTsv(formatTsv(matrix))).toEqual(matrix);
  });

  it("keeps a lone empty final cell as a row", () => {
    const matrix = [["a"], [""]];
    expect(parseTsv(formatTsv(matrix))).toEqual(matrix);
  });

  it("reads parseTsv output from Sheets (CRLF, quoted, trailing newline) back unchanged", () => {
    const fromSheets = 'a\t"b\r\nc"\r\nd\te\r\n';
    const parsed = parseTsv(fromSheets);
    expect(parsed).toEqual([
      ["a", "b\r\nc"],
      ["d", "e"],
    ]);
    expect(parseTsv(formatTsv(parsed))).toEqual(parsed);
  });

  it("builds a matrix for a range from a text accessor", () => {
    const matrix = rangeToMatrix({ top: 1, bottom: 2, left: 0, right: 1 }, (r, c) => `${r}:${c}`);
    expect(matrix).toEqual([
      ["1:0", "1:1"],
      ["2:0", "2:1"],
    ]);
  });
});

// A tiny grid: 4 rows x 3 columns. Column 0 text, 1 read-only, 2 number (min 0).
type Row = { id: string; title: string | null; points: number | null };
const rows: Row[] = [
  { id: "r1", title: "One", points: 1 },
  { id: "r2", title: "Two", points: 2 },
  { id: "r3", title: "Three", points: null },
  { id: "r4", title: null, points: 4 },
];
const noopSave = async () => ({ ok: true as const });
const titleEdit: GridEdit<Row> = {
  kind: "text",
  field: "title",
  getValue: (row) => row.title,
  save: noopSave,
};
const pointsEdit: GridEdit<Row> = {
  kind: "number",
  field: "points",
  min: 0,
  getValue: (row) => row.points,
  save: noopSave,
};
const edits: (GridEdit<Row> | undefined)[] = [titleEdit, undefined, pointsEdit];
const columnIds = ["title", "note", "points"];

function makeGrid(options: { readOnly?: boolean; data?: Row[] } = {}): PlanGrid<Row> {
  const data = options.data ?? rows;
  return {
    rowCount: data.length,
    colCount: 3,
    rowAt: (index) => (data[index] ? { id: data[index].id, row: data[index] } : undefined),
    columnIdAt: (index) => columnIds[index],
    editAt: (_r, c) => (options.readOnly ? undefined : edits[c]),
    textAt: (r, c) => {
      const edit = edits[c];
      if (!edit) return "note";
      const value = edit.getValue(data[r]);
      return value === null ? "" : String(value);
    },
  };
}

describe("planPaste", () => {
  const at = (row: number, col: number) => normalizeRange({ row, col }, { row, col });

  it("anchors a block at the top-left of the selection", () => {
    const plan = planPaste([["A", "x", "10"], ["B", "x", "20"]], at(1, 0), makeGrid());
    expect(plan.changes.map((c) => [c.rowId, c.columnId, c.next])).toEqual([
      ["r2", "title", "A"],
      ["r2", "points", 10],
      ["r3", "title", "B"],
      ["r3", "points", 20],
    ]);
    // The read-only middle column is skipped and counted.
    expect(plan.skippedReadOnly).toBe(2);
    expect(plan.clamped).toBeNull();
    expect(plan.changes[0]).toMatchObject({ prev: "Two", rowIndex: 1, colIndex: 0 });
  });

  it("clamps rows to the loaded page and reports it", () => {
    const plan = planPaste([["a"], ["b"], ["c"], ["d"]], at(2, 0), makeGrid());
    expect(plan.changes.map((c) => c.rowId)).toEqual(["r3", "r4"]);
    expect(plan.clamped).toEqual({
      rows: { received: 4, applied: 2 },
      cols: { received: 1, applied: 1 },
    });
    expect(describePlan(plan, "paste")).toMatch(/2 of 4 rows pasted: the page ends here/);
  });

  it("clamps columns to the visible columns", () => {
    const plan = planPaste([["a", "b", "5", "overflow"]], at(0, 0), makeGrid());
    expect(plan.clamped?.cols).toEqual({ received: 4, applied: 3 });
    expect(plan.changes.map((c) => c.columnId)).toEqual(["title", "points"]);
  });

  it("fills the whole selected range from a 1x1 clipboard", () => {
    const range = normalizeRange({ row: 0, col: 0 }, { row: 2, col: 0 });
    const plan = planPaste([["same"]], range, makeGrid());
    expect(plan.changes.map((c) => [c.rowId, c.next])).toEqual([
      ["r1", "same"],
      ["r2", "same"],
      ["r3", "same"],
    ]);
    expect(plan.clamped).toBeNull();
  });

  it("skips cells whose text fails the column's parse, and keeps the rest", () => {
    const plan = planPaste([["ok", "", "-3"], ["ok2", "", "7"]], at(0, 0), makeGrid());
    expect(plan.parseErrors).toHaveLength(1);
    expect(plan.parseErrors[0]).toMatchObject({ rowId: "r1", columnId: "points", error: "Must be at least 0" });
    expect(plan.changes.map((c) => c.next)).toEqual(["ok", "ok2", 7]);
  });

  it("counts a no-op paste as unchanged and plans nothing", () => {
    const plan = planPaste([["One"]], at(0, 0), makeGrid());
    expect(plan.changes).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("leaves a cell alone when a ragged row has no value for it", () => {
    const plan = planPaste([["A", "x", "9"], ["B"]], at(0, 0), makeGrid());
    expect(plan.changes.map((c) => [c.rowId, c.columnId])).toEqual([
      ["r1", "title"],
      ["r1", "points"],
      ["r2", "title"],
    ]);
  });

  it("refuses an oversized paste outright instead of writing a prefix", () => {
    const plan = planPaste([["a", "b", "1"], ["a", "b", "1"], ["a", "b", "1"]], at(0, 0), makeGrid(), 8);
    expect(plan.changes).toHaveLength(0);
    expect(plan.overLimit).toEqual({ cells: 9, limit: 8 });
    expect(describePlan(plan, "paste")).toMatch(/limit is 8/);
  });

  it("refuses an oversized 1x1 fill", () => {
    const range = normalizeRange({ row: 0, col: 0 }, { row: 3, col: 2 });
    const plan = planPaste([["x"]], range, makeGrid(), 5);
    expect(plan.overLimit).toEqual({ cells: 12, limit: 5 });
    expect(plan.changes).toHaveLength(0);
  });

  it("plans nothing in a read-only grid", () => {
    const plan = planPaste([["a", "b", "1"]], at(0, 0), makeGrid({ readOnly: true }));
    expect(plan.changes).toHaveLength(0);
    expect(plan.skippedReadOnly).toBe(3);
  });

  it("ignores an empty clipboard", () => {
    expect(planPaste([], at(0, 0), makeGrid()).changes).toHaveLength(0);
  });
});

describe("planFill", () => {
  it("copies the source row down, column by column (Ctrl+D)", () => {
    const source = normalizeRange({ row: 0, col: 0 }, { row: 0, col: 2 });
    const plan = planFill(source, { from: 1, to: 3 }, makeGrid());
    expect(plan.changes.map((c) => [c.rowId, c.columnId, c.next])).toEqual([
      ["r2", "title", "One"],
      ["r2", "points", 1],
      ["r3", "title", "One"],
      ["r3", "points", 1],
      ["r4", "title", "One"],
      // r4 already has points 4; 1 changes it.
      ["r4", "points", 1],
    ]);
  });

  it("repeats a multi-row source cyclically (fill handle)", () => {
    const source = normalizeRange({ row: 0, col: 0 }, { row: 1, col: 0 });
    const plan = planFill(source, { from: 2, to: 3 }, makeGrid());
    expect(plan.changes.map((c) => c.next)).toEqual(["One", "Two"]);
  });

  it("does no series inference", () => {
    const source = normalizeRange({ row: 0, col: 2 }, { row: 1, col: 2 });
    const plan = planFill(source, { from: 2, to: 3 }, makeGrid());
    expect(plan.changes.map((c) => c.next)).toEqual([1, 2]);
  });

  it("fills an empty source as a clear", () => {
    const data: Row[] = [{ id: "a", title: null, points: null }, { id: "b", title: "x", points: 1 }];
    const plan = planFill(
      normalizeRange({ row: 0, col: 0 }, { row: 0, col: 2 }),
      { from: 1, to: 1 },
      makeGrid({ data }),
    );
    expect(plan.changes.map((c) => c.next)).toEqual([null, null]);
  });

  it("is bounded by the limit", () => {
    const source = normalizeRange({ row: 0, col: 0 }, { row: 0, col: 2 });
    expect(planFill(source, { from: 1, to: 3 }, makeGrid(), 5).overLimit).toEqual({ cells: 9, limit: 5 });
  });

  it("skips read-only cells in a read-only grid", () => {
    const source = normalizeRange({ row: 0, col: 0 }, { row: 0, col: 2 });
    const plan = planFill(source, { from: 1, to: 1 }, makeGrid({ readOnly: true }));
    expect(plan.changes).toHaveLength(0);
    expect(plan.skippedReadOnly).toBe(3);
  });
});

describe("planClear", () => {
  it("parses the empty string for each editable cell", () => {
    const plan = planClear(normalizeRange({ row: 0, col: 0 }, { row: 1, col: 2 }), makeGrid());
    expect(plan.changes.map((c) => [c.rowId, c.columnId, c.next])).toEqual([
      ["r1", "title", null],
      ["r1", "points", null],
      ["r2", "title", null],
      ["r2", "points", null],
    ]);
    expect(plan.skippedReadOnly).toBe(2);
  });
});

describe("runGrouped", () => {
  it("runs one group's items in order and returns results in input order", async () => {
    const log: string[] = [];
    const items = [
      { g: "a", n: 1 },
      { g: "b", n: 2 },
      { g: "a", n: 3 },
    ];
    const out = await runGrouped(
      items,
      (item) => item.g,
      async (item) => {
        log.push(`start${item.n}`);
        await new Promise((resolve) => setTimeout(resolve, item.n === 1 ? 10 : 0));
        log.push(`end${item.n}`);
        return item.n * 10;
      },
    );
    expect(out).toEqual([10, 20, 30]);
    // Same-row cells never overlap: item 3 starts after item 1 ends.
    expect(log.indexOf("start3")).toBeGreaterThan(log.indexOf("end1"));
  });

  it("never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, index) => ({ g: `g${index}` }));
    await runGrouped(
      items,
      (item) => item.g,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
      },
      3,
    );
    expect(peak).toBe(3);
  });

  it("handles no items", async () => {
    expect(await runGrouped([], () => "x", async () => 1)).toEqual([]);
  });
});

describe("createChangeSet", () => {
  it("wraps one gesture with a unique id", () => {
    const a = createChangeSet("paste", []);
    const b = createChangeSet("paste", []);
    expect(a.source).toBe("paste");
    expect(a.id).not.toBe(b.id);
  });
});

describe("range reducer", () => {
  const cell = (rowId: string, columnId: string) => ({ rowId, columnId });
  const active = gridInteractionReducer(INITIAL_GRID_INTERACTION, {
    type: "focusCell",
    cell: cell("r1", "a"),
    rowIndex: 0,
  });

  it("extends from the active cell and keeps the anchor", () => {
    const state = gridInteractionReducer(active, { type: "extendRange", cell: cell("r3", "b") });
    expect(state.active).toEqual(cell("r1", "a"));
    expect(state.rangeEnd).toEqual(cell("r3", "b"));
  });

  it("extending back onto the anchor clears the range", () => {
    const extended = gridInteractionReducer(active, { type: "extendRange", cell: cell("r2", "a") });
    const back = gridInteractionReducer(extended, { type: "extendRange", cell: cell("r1", "a") });
    expect(back.rangeEnd).toBeNull();
  });

  it("collapses on plain navigation, pointer-down and edit", () => {
    const extended = gridInteractionReducer(active, { type: "extendRange", cell: cell("r2", "a") });
    expect(
      gridInteractionReducer(extended, { type: "focusCell", cell: cell("r2", "a"), rowIndex: 1 }).rangeEnd,
    ).toBeNull();
    expect(
      gridInteractionReducer(extended, { type: "beginPointer", cell: cell("r1", "a"), rowIndex: 0 }).rangeEnd,
    ).toBeNull();
    expect(gridInteractionReducer(extended, { type: "startEdit", text: "x" }).rangeEnd).toBeNull();
    expect(gridInteractionReducer(extended, { type: "collapseRange" }).rangeEnd).toBeNull();
  });

  it("does not extend while an editor is open", () => {
    const editing = gridInteractionReducer(active, { type: "startEdit", text: "" });
    expect(gridInteractionReducer(editing, { type: "extendRange", cell: cell("r2", "a") }).rangeEnd).toBeNull();
  });

  it("keeps the open editor when the press lands inside it", () => {
    const editing = gridInteractionReducer(active, { type: "startEdit", text: "t" });
    expect(
      gridInteractionReducer(editing, { type: "beginPointer", cell: cell("r1", "a"), rowIndex: 0 }),
    ).toBe(editing);
  });

  it("drops a range whose corner no longer exists", () => {
    const extended = gridInteractionReducer(active, { type: "extendRange", cell: cell("r3", "b") });
    expect(resolveRangeEnd(extended, ["r1", "r2", "r3"], ["a", "b"])).toEqual({ row: 2, col: 1 });
    expect(resolveRangeEnd(extended, ["r1", "r2"], ["a", "b"])).toBeNull();
  });
});

describe("range keys", () => {
  it("Shift+Arrow extends instead of moving", () => {
    expect(resolveGridKey({ key: "ArrowDown", shiftKey: true }, "nav")).toEqual({
      type: "extend",
      rows: 1,
      cols: 0,
    });
    expect(resolveGridKey({ key: "ArrowLeft", shiftKey: true }, "nav")).toEqual({
      type: "extend",
      rows: 0,
      cols: -1,
    });
    expect(resolveGridKey({ key: "ArrowDown" }, "nav")).toEqual({ type: "move", rows: 1, cols: 0 });
  });

  it("Ctrl/Cmd+D fills down in nav mode only", () => {
    expect(resolveGridKey({ key: "d", ctrlKey: true }, "nav")).toEqual({ type: "fillDown" });
    expect(resolveGridKey({ key: "D", metaKey: true }, "nav")).toEqual({ type: "fillDown" });
    expect(resolveGridKey({ key: "d", ctrlKey: true }, "edit")).toBeNull();
  });

  it("Escape collapses in nav mode", () => {
    expect(resolveGridKey({ key: "Escape" }, "nav")).toEqual({ type: "collapse" });
  });
});
