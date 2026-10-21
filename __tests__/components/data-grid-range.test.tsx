// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DataGrid } from "@/components/data-grid/data-grid";
import type { GridChangeSet } from "@/components/data-grid/interaction/range-ops";
import type { GridActionResult, GridColumnDef } from "@/components/data-grid/types";

afterEach(cleanup);

type Row = {
  id: string;
  data: { title: string; status: string; points: number | null; done: boolean };
};

const makeRows = (): Row[] =>
  ["Dark mode", "Bulk export", "Audit log", "Search", "Billing", "Sso"].map((title, index) => ({
    id: `r${index + 1}`,
    data: { title, status: index % 2 === 0 ? "OPEN" : "PLANNED", points: index + 1, done: false },
  }));

const STATUS_OPTIONS = [
  { value: "OPEN", label: "Open" },
  { value: "PLANNED", label: "Planned" },
] as const;

type SaveMock<V> = Mock<(row: Row, next: V) => Promise<GridActionResult>>;
type Saves = { title: SaveMock<string | null>; status: SaveMock<string>; points: SaveMock<number | null> };

const ok = async (): Promise<GridActionResult> => ({ ok: true });
function makeSaves(): Saves {
  return { title: vi.fn(ok), status: vi.fn(ok), points: vi.fn(ok) };
}

const patch = (row: Row, change: Partial<Row["data"]>): Row => ({
  ...row,
  data: { ...row.data, ...change },
});

// Column order: 0 title, 1 note (read-only), 2 status, 3 points.
function makeColumns(saves: Saves): GridColumnDef<Row>[] {
  return [
    {
      id: "title",
      header: "Title",
      meta: {
        label: "Title",
        edit: {
          kind: "text",
          field: "data",
          getValue: (row) => row.data.title,
          applyOptimistic: (row, next) => patch(row, { title: next ?? "" }),
          triggerLabel: (row) => `Title for ${row.data.title}`,
          save: saves.title,
        },
      },
      cell: ({ row }) => <span>{row.original.data.title}</span>,
    },
    { id: "note", header: "Note", meta: { label: "Note" }, cell: () => <span>note</span> },
    {
      id: "status",
      header: "Status",
      meta: {
        label: "Status",
        edit: {
          kind: "select",
          field: "data",
          options: STATUS_OPTIONS,
          getValue: (row) => row.data.status,
          applyOptimistic: (row, next) => patch(row, { status: next }),
          save: saves.status,
        },
      },
    },
    {
      id: "points",
      header: "Points",
      meta: {
        label: "Points",
        edit: {
          kind: "number",
          min: 0,
          field: "data",
          getValue: (row) => row.data.points,
          applyOptimistic: (row, next) => patch(row, { points: next }),
          save: saves.points,
        },
      },
    },
  ];
}

type GridProps = Partial<React.ComponentProps<typeof DataGrid<Row>>>;

function renderSheet(saves: Saves, props: GridProps = {}) {
  const rows = props.rows ?? makeRows();
  const merged = {
    gridId: "range-test",
    columns: makeColumns(saves),
    rows,
    getRowId: (row: Row) => row.id,
    total: rows.length,
    caption: "Range grid",
    interaction: "sheet",
    ...props,
  } as React.ComponentProps<typeof DataGrid<Row>>;
  return render(<DataGrid<Row> {...merged} />);
}

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const cellEl = (rowId: string, col: string) =>
  rowEl(rowId).querySelector<HTMLElement>(`[data-col="${col}"]`)!;

function focusCell(rowId: string, col: string) {
  const cell = cellEl(rowId, col);
  act(() => cell.focus());
  return cell;
}

const key = (target: HTMLElement, init: KeyboardEventInit) => fireEvent.keyDown(target, init);

/** Selects r{from}..r{to} x cols via Shift+Arrow from the first cell. */
function selectByKeyboard(startRow: string, startCol: string, down: number, right: number) {
  const cell = focusCell(startRow, startCol);
  for (let i = 0; i < down; i += 1) key(cell, { key: "ArrowDown", shiftKey: true });
  for (let i = 0; i < right; i += 1) key(cell, { key: "ArrowRight", shiftKey: true });
  return cell;
}

const selected = (rowId: string, col: string) =>
  cellEl(rowId, col).getAttribute("aria-selected") === "true";

/** [rowId, value] per save, sorted by row: saves for different rows run concurrently. */
const callsOf = (mock: Mock<(row: Row, next: never) => Promise<GridActionResult>>) =>
  mock.mock.calls
    .map(([row, next]) => [row.id, next] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

const pasteInto = (target: HTMLElement, text: string) =>
  fireEvent.paste(target, { clipboardData: { getData: () => text } });

function copyFrom(target: HTMLElement) {
  const setData = vi.fn();
  fireEvent.copy(target, { clipboardData: { setData } });
  return setData;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  window.localStorage.clear();
});

describe("range selection", () => {
  it("Shift+Arrow extends from the active cell and marks the range with aria-selected", () => {
    renderSheet(makeSaves());
    const cell = selectByKeyboard("r1", "title", 2, 2);

    for (const row of ["r1", "r2", "r3"]) {
      for (const col of ["title", "note", "status"]) {
        expect(selected(row, col), `${row}/${col}`).toBe(true);
      }
    }
    expect(selected("r4", "title")).toBe(false);
    expect(selected("r1", "points")).toBe(false);
    expect(cellEl("r2", "note")).toHaveAttribute("data-range", "true");
    // The anchor keeps DOM focus and the roving tab stop.
    expect(cell).toHaveAttribute("data-sheet-active", "true");
    expect(cell).toHaveFocus();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-multiselectable", "true");
  });

  it("shrinks the range when the corner moves back", () => {
    renderSheet(makeSaves());
    const cell = selectByKeyboard("r1", "title", 2, 0);
    key(cell, { key: "ArrowUp", shiftKey: true });
    expect(selected("r2", "title")).toBe(true);
    expect(selected("r3", "title")).toBe(false);
    key(cell, { key: "ArrowUp", shiftKey: true });
    // Back on the anchor: no multi-cell range, so no aria-selected anywhere.
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("stops the moving corner at the edges of the page", () => {
    renderSheet(makeSaves());
    const cell = selectByKeyboard("r5", "points", 5, 5);
    expect(selected("r6", "points")).toBe(true);
    expect(selected("r5", "points")).toBe(true);
    // Already on the last column: nothing to the left was swept in.
    expect(selected("r5", "status")).toBe(false);
    expect(cell).toHaveFocus();
  });

  it("Shift+click extends from the active cell", () => {
    renderSheet(makeSaves());
    focusCell("r1", "title");
    fireEvent.mouseDown(cellEl("r3", "status"), { shiftKey: true });
    expect(selected("r1", "title")).toBe(true);
    expect(selected("r3", "status")).toBe(true);
    expect(selected("r4", "title")).toBe(false);
  });

  it("drag selects across body cells", () => {
    renderSheet(makeSaves());
    fireEvent.mouseDown(cellEl("r1", "title"));
    fireEvent.mouseMove(cellEl("r2", "status"), { buttons: 1 });
    fireEvent.mouseMove(cellEl("r3", "points"), { buttons: 1 });
    fireEvent.mouseUp(cellEl("r3", "points"));

    expect(selected("r1", "title")).toBe(true);
    expect(selected("r3", "points")).toBe(true);
    expect(selected("r2", "note")).toBe(true);
    // Moving after release does not keep extending.
    fireEvent.mouseMove(cellEl("r5", "points"), { buttons: 0 });
    expect(selected("r5", "points")).toBe(false);
  });

  it("a plain click collapses the range", () => {
    renderSheet(makeSaves());
    selectByKeyboard("r1", "title", 2, 1);
    fireEvent.mouseDown(cellEl("r1", "title"));
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("Escape collapses the range; plain arrows then move from the active cell", () => {
    renderSheet(makeSaves());
    const cell = selectByKeyboard("r1", "title", 2, 0);
    key(cell, { key: "Escape" });
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
    key(cell, { key: "ArrowDown" });
    expect(cellEl("r2", "title")).toHaveAttribute("data-sheet-active", "true");
  });

  it("body drag never starts a column reorder", () => {
    renderSheet(makeSaves());
    const headers = () => Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent);
    const before = headers();
    const orderBefore = JSON.stringify(Object.entries(window.localStorage));

    const from = cellEl("r1", "title");
    // Pointer and mouse events together, as a real drag produces both.
    fireEvent.pointerDown(from, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.mouseDown(from);
    const headerCell = document.querySelector("thead th[data-col='points']")!;
    for (const target of [cellEl("r2", "status"), headerCell, cellEl("r3", "points")]) {
      fireEvent.pointerMove(target, { pointerId: 1, clientX: 80, clientY: 80, buttons: 1 });
      fireEvent.mouseMove(target, { buttons: 1, clientX: 80, clientY: 80 });
    }
    fireEvent.pointerUp(cellEl("r3", "points"), { pointerId: 1 });
    fireEvent.mouseUp(cellEl("r3", "points"));

    expect(headers()).toEqual(before);
    expect(JSON.stringify(Object.entries(window.localStorage))).toBe(orderBefore);
    // dnd-kit announces a pick-up in its live region; none happened.
    expect(document.body.textContent).not.toMatch(/Picked up/i);
    // The drag selected cells instead.
    expect(selected("r3", "points")).toBe(true);
  });
});

describe("copy and cut", () => {
  it("copies a range as TSV using each column's format", () => {
    renderSheet(makeSaves());
    const cell = selectByKeyboard("r1", "title", 1, 3);
    const setData = copyFrom(cell);
    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "Dark mode\tnote\tOpen\t1\nBulk export\tnote\tPlanned\t2",
    );
  });

  it("quotes cells with tabs, newlines and quotes", () => {
    const rows = makeRows();
    rows[0] = patch(rows[0], { title: 'a\tb "c"\nd' });
    renderSheet(makeSaves(), { rows });
    const cell = focusCell("r1", "title");
    expect(copyFrom(cell)).toHaveBeenCalledWith("text/plain", '"a\tb ""c""\nd"');
  });

  it("copies a single active cell", () => {
    renderSheet(makeSaves());
    const cell = focusCell("r2", "status");
    expect(copyFrom(cell)).toHaveBeenCalledWith("text/plain", "Planned");
  });

  it("is allowed in a read-only grid", () => {
    renderSheet(makeSaves(), { readOnly: true });
    const cell = selectByKeyboard("r1", "title", 1, 0);
    expect(copyFrom(cell)).toHaveBeenCalledWith("text/plain", "Dark mode\nBulk export");
  });

  it("cut copies then clears through the save path", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = selectByKeyboard("r1", "title", 1, 0);
    const setData = vi.fn();
    fireEvent.cut(cell, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "Dark mode\nBulk export");
    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(callsOf(saves.title)).toEqual([
      ["r1", null],
      ["r2", null],
    ]);
  });

  it("cut does nothing in a read-only grid", () => {
    const saves = makeSaves();
    renderSheet(saves, { readOnly: true });
    const cell = selectByKeyboard("r1", "title", 1, 0);
    const setData = vi.fn();
    fireEvent.cut(cell, { clipboardData: { setData } });
    expect(setData).not.toHaveBeenCalled();
    expect(saves.title).not.toHaveBeenCalled();
  });

  it("does not hijack copy while an editor is open", () => {
    renderSheet(makeSaves());
    const cell = focusCell("r1", "title");
    key(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    const setData = vi.fn();
    fireEvent.copy(input, { clipboardData: { setData } });
    expect(setData).not.toHaveBeenCalled();
  });
});

describe("paste", () => {
  it("writes each cell through parse and save, skipping read-only columns", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = focusCell("r2", "title");
    pasteInto(cell, "X\tignored\tOpen\t5\nY\t\tPlanned\t6");

    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(callsOf(saves.title)).toEqual([
      ["r2", "X"],
      ["r3", "Y"],
    ]);
    // r2 was PLANNED and r3 was OPEN: both change.
    expect(callsOf(saves.status)).toEqual([
      ["r2", "OPEN"],
      ["r3", "PLANNED"],
    ]);
    expect(callsOf(saves.points)).toEqual([
      ["r2", 5],
      ["r3", 6],
    ]);
    expect(cellEl("r2", "title")).toHaveTextContent("X");
    expect(cellEl("r3", "title")).toHaveTextContent("Y");
  });

  it("shows pasted values at once, before any save resolves", async () => {
    const release: Array<() => void> = [];
    const saves = makeSaves();
    saves.title.mockImplementation(
      () => new Promise<GridActionResult>((resolve) => release.push(() => resolve({ ok: true }))),
    );
    renderSheet(saves);
    pasteInto(focusCell("r1", "title"), "A\nB\nC");

    // Optimistic: all three rows show their value in one render, rows are pending.
    expect(cellEl("r1", "title")).toHaveTextContent("A");
    expect(cellEl("r2", "title")).toHaveTextContent("B");
    expect(cellEl("r3", "title")).toHaveTextContent("C");
    expect(rowEl("r3")).toHaveAttribute("data-pending", "true");
    // Bounded concurrency: distinct rows go in parallel (up to 3).
    await waitFor(() => expect(release).toHaveLength(3));

    await act(async () => release.forEach((resolve) => resolve()));
    await waitFor(() => expect(rowEl("r3")).not.toHaveAttribute("data-pending"));
    expect(cellEl("r1", "title")).toHaveTextContent("A");
  });

  it("clamps to the loaded page and shows a non-blocking message", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    pasteInto(focusCell("r5", "title"), "a\nb\nc\nd");

    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(saves.title.mock.calls.map(([row]) => row.id)).toEqual(["r5", "r6"]);
    const notice = screen.getByTestId("grid-range-notice");
    expect(notice).toHaveTextContent("2 of 4 rows pasted: the page ends here");
    expect(notice).toHaveAttribute("role", "status");
    expect(screen.getByTestId("grid-live-region")).toHaveTextContent(/page ends here/);

    fireEvent.click(screen.getByTestId("grid-range-notice-dismiss"));
    expect(screen.queryByTestId("grid-range-notice")).toBeNull();
  });

  it("a 1x1 value fills the whole selected range", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = selectByKeyboard("r1", "title", 2, 0);
    pasteInto(cell, "Same");
    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(3));
    expect(callsOf(saves.title)).toEqual([
      ["r1", "Same"],
      ["r2", "Same"],
      ["r3", "Same"],
    ]);
  });

  it("anchors a larger block at the top-left of a range selected bottom-up", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = focusCell("r3", "title");
    key(cell, { key: "ArrowUp", shiftKey: true });
    pasteInto(cell, "P\nQ");
    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(saves.title.mock.calls.map(([row]) => row.id)).toEqual(["r2", "r3"]);
  });

  it("reports cells that fail parse and writes the rest", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    pasteInto(focusCell("r1", "points"), "-4\n9\nnope");
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(1));
    expect(saves.points.mock.calls[0][1]).toBe(9);
    expect(screen.getByTestId("grid-range-notice")).toHaveTextContent("2 cells skipped");
  });

  it("rolls back only the cell whose save failed and surfaces the error", async () => {
    const saves = makeSaves();
    saves.title.mockImplementation(async (row) =>
      row.id === "r2" ? { ok: false, error: "Title is taken" } : { ok: true },
    );
    const changeSets: GridChangeSet[] = [];
    renderSheet(saves, { onChangeSet: (set) => changeSets.push(set) });
    // r2 changes title (fails) AND status (succeeds): the status edit must stand.
    pasteInto(focusCell("r1", "title"), "A\tn\tPlanned\nB\tn\tOpen\nC\tn\tPlanned");

    await waitFor(() => expect(changeSets).toHaveLength(1));
    expect(cellEl("r1", "title")).toHaveTextContent("A");
    expect(cellEl("r2", "title")).toHaveTextContent("Bulk export");
    expect(cellEl("r3", "title")).toHaveTextContent("C");
    expect(cellEl("r2", "status")).toHaveTextContent("Open");
    expect(screen.getByTestId("grid-error-strip")).toHaveTextContent("Title: Title is taken");
    expect(rowEl("r2")).toHaveAttribute("data-error", "true");
    expect(rowEl("r1")).not.toHaveAttribute("data-error");
  });

  it("records one change set for the whole paste", async () => {
    const saves = makeSaves();
    saves.points.mockImplementation(async (row) =>
      row.id === "r2" ? { ok: false, error: "Nope" } : { ok: true },
    );
    const changeSets: GridChangeSet[] = [];
    renderSheet(saves, { onChangeSet: (set) => changeSets.push(set) });
    pasteInto(focusCell("r1", "points"), "10\n20\n30");

    await waitFor(() => expect(changeSets).toHaveLength(1));
    const [set] = changeSets;
    expect(set.source).toBe("paste");
    expect(set.changes).toEqual([
      { rowId: "r1", columnId: "points", field: "data", prev: 1, next: 10, status: "saved", error: undefined },
      { rowId: "r2", columnId: "points", field: "data", prev: 2, next: 20, status: "failed", error: "Nope" },
      { rowId: "r3", columnId: "points", field: "data", prev: 3, next: 30, status: "saved", error: undefined },
    ]);
  });

  it("turns a rejected save into a rollback rather than a stuck pending row", async () => {
    const saves = makeSaves();
    saves.title.mockImplementation(async () => {
      throw new Error("network");
    });
    renderSheet(saves);
    pasteInto(focusCell("r1", "title"), "A");
    await waitFor(() => expect(screen.getByTestId("grid-error-strip")).toBeInTheDocument());
    expect(cellEl("r1", "title")).toHaveTextContent("Dark mode");
    expect(rowEl("r1")).not.toHaveAttribute("data-pending");
  });

  it("refuses a paste over the limit and writes nothing", async () => {
    const saves = makeSaves();
    renderSheet(saves, { rangeLimit: 4 });
    const cell = selectByKeyboard("r1", "title", 2, 1);
    pasteInto(cell, "Z");
    expect(screen.getByTestId("grid-range-notice")).toHaveTextContent(/limit is 4/);
    expect(saves.title).not.toHaveBeenCalled();
  });

  it("ignores an empty clipboard", () => {
    const saves = makeSaves();
    renderSheet(saves);
    pasteInto(focusCell("r1", "title"), "");
    expect(saves.title).not.toHaveBeenCalled();
  });

  it("is disabled in a read-only grid", () => {
    const saves = makeSaves();
    renderSheet(saves, { readOnly: true });
    pasteInto(focusCell("r1", "title"), "A\tn\tPlanned\t9");
    expect(saves.title).not.toHaveBeenCalled();
    expect(saves.status).not.toHaveBeenCalled();
    expect(saves.points).not.toHaveBeenCalled();
    expect(cellEl("r1", "title")).toHaveTextContent("Dark mode");
  });

  it("leaves native paste alone while an editor is open", () => {
    const saves = makeSaves();
    renderSheet(saves);
    key(focusCell("r1", "title"), { key: "Enter" });
    pasteInto(screen.getByTestId("grid-cell-input"), "pasted");
    expect(saves.title).not.toHaveBeenCalled();
  });
});

describe("delete over a range", () => {
  it("clears every editable cell in the range", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = selectByKeyboard("r1", "title", 1, 3);
    key(cell, { key: "Delete" });
    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(saves.points).toHaveBeenCalledTimes(2);
    expect(saves.points.mock.calls.map(([, next]) => next)).toEqual([null, null]);
    // Status is a select: "" is not an option, so it is reported, not written.
    expect(saves.status).not.toHaveBeenCalled();
    expect(screen.getByTestId("grid-range-notice")).toHaveTextContent("2 cells skipped");
  });

  it("does nothing in a read-only grid", () => {
    const saves = makeSaves();
    renderSheet(saves, { readOnly: true });
    const cell = selectByKeyboard("r1", "title", 1, 0);
    key(cell, { key: "Delete" });
    expect(saves.title).not.toHaveBeenCalled();
  });
});

describe("fill down", () => {
  it("Ctrl+D copies the top row to the rest of the range", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = selectByKeyboard("r1", "title", 2, 3);
    const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      cell.dispatchEvent(event);
    });
    // The browser's bookmark shortcut is suppressed.
    expect(event.defaultPrevented).toBe(true);

    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(callsOf(saves.title)).toEqual([
      ["r2", "Dark mode"],
      ["r3", "Dark mode"],
    ]);
    // r1 is OPEN: r2 (PLANNED) changes, r3 (OPEN) already matches.
    expect(callsOf(saves.status)).toEqual([["r2", "OPEN"]]);
    expect(callsOf(saves.points)).toEqual([
      ["r2", 1],
      ["r3", 1],
    ]);
  });

  it("Ctrl+D on a lone cell copies the cell above", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    const cell = focusCell("r3", "points");
    key(cell, { key: "d", ctrlKey: true });
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(1));
    expect(saves.points.mock.calls[0][0].id).toBe("r3");
    expect(saves.points.mock.calls[0][1]).toBe(2);
  });

  it("Ctrl+D is disabled in a read-only grid but still swallowed", () => {
    const saves = makeSaves();
    renderSheet(saves, { readOnly: true });
    const cell = selectByKeyboard("r1", "title", 2, 0);
    key(cell, { key: "d", ctrlKey: true });
    expect(saves.title).not.toHaveBeenCalled();
  });

  it("the fill handle drags the selection down and applies on release", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    focusCell("r1", "title");
    const handle = screen.getByTestId("grid-fill-handle");
    expect(cellEl("r1", "title")).toContainElement(handle);

    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(cellEl("r3", "title"), { buttons: 1 });
    expect(cellEl("r2", "title")).toHaveAttribute("data-fill-preview", "true");
    expect(cellEl("r3", "title")).toHaveAttribute("data-fill-preview", "true");
    expect(cellEl("r4", "title")).not.toHaveAttribute("data-fill-preview");
    fireEvent.mouseUp(cellEl("r3", "title"));

    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(callsOf(saves.title)).toEqual([
      ["r2", "Dark mode"],
      ["r3", "Dark mode"],
    ]);
    // The selection grew to cover the filled rows, preview cleared.
    expect(selected("r3", "title")).toBe(true);
    expect(cellEl("r2", "title")).not.toHaveAttribute("data-fill-preview");
  });

  it("releasing the fill handle outside the grid cancels the fill", () => {
    const saves = makeSaves();
    renderSheet(saves);
    focusCell("r1", "title");
    fireEvent.mouseDown(screen.getByTestId("grid-fill-handle"));
    fireEvent.mouseMove(cellEl("r3", "title"), { buttons: 1 });
    fireEvent.mouseUp(document.body);
    expect(saves.title).not.toHaveBeenCalled();
    expect(cellEl("r2", "title")).not.toHaveAttribute("data-fill-preview");
  });

  it("the fill handle repeats a multi-row selection", async () => {
    const saves = makeSaves();
    renderSheet(saves);
    selectByKeyboard("r1", "points", 1, 0);
    const handle = screen.getByTestId("grid-fill-handle");
    expect(cellEl("r2", "points")).toContainElement(handle);
    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(cellEl("r4", "points"), { buttons: 1 });
    fireEvent.mouseUp(cellEl("r4", "points"));
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(2));
    // 1,2 repeats as 1,2: r3 (3) -> 1, r4 (4) -> 2. No series inference.
    expect(callsOf(saves.points)).toEqual([
      ["r3", 1],
      ["r4", 2],
    ]);
  });

  it("has no fill handle in a read-only grid", () => {
    renderSheet(makeSaves(), { readOnly: true });
    focusCell("r1", "title");
    expect(screen.queryByTestId("grid-fill-handle")).toBeNull();
  });

  it("has no fill handle on a read-only column", () => {
    renderSheet(makeSaves());
    focusCell("r1", "note");
    expect(screen.queryByTestId("grid-fill-handle")).toBeNull();
  });
});

describe("grids without interaction='sheet'", () => {
  it("get no range behaviour, handle or ARIA", () => {
    const saves = makeSaves();
    renderSheet(saves, { interaction: undefined });
    expect(screen.queryByRole("grid")).toBeNull();
    fireEvent.mouseDown(cellEl("r1", "title"));
    fireEvent.mouseMove(cellEl("r3", "points"), { buttons: 1 });
    pasteInto(cellEl("r1", "title"), "A\tB");
    expect(document.querySelector("[aria-selected]")).toBeNull();
    expect(document.querySelector("[data-fill-handle]")).toBeNull();
    expect(saves.title).not.toHaveBeenCalled();
  });
});
