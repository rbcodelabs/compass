// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DataGrid } from "@/components/data-grid/data-grid";
import type { GridChangeSet } from "@/components/data-grid/interaction/range-ops";
import type { GridActionResult, GridColumnDef } from "@/components/data-grid/types";

afterEach(cleanup);

type Row = { id: string; data: { title: string; points: number | null } };

const makeRows = (): Row[] =>
  ["Dark mode", "Bulk export", "Audit log", "Search"].map((title, index) => ({
    id: `r${index + 1}`,
    data: { title, points: index + 1 },
  }));

type SaveMock<V> = Mock<(row: Row, next: V) => Promise<GridActionResult>>;
type Saves = { title: SaveMock<string | null>; points: SaveMock<number | null> };

const ok = async (): Promise<GridActionResult> => ({ ok: true });
const makeSaves = (): Saves => ({ title: vi.fn(ok), points: vi.fn(ok) });

const patch = (row: Row, change: Partial<Row["data"]>): Row => ({ ...row, data: { ...row.data, ...change } });

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

/** One stable column array per mount: a new one would remount every cell on rerender. */
function mountSheet(saves: Saves, props: GridProps = {}) {
  const columns = makeColumns(saves);
  const element = (extra: GridProps = {}) => {
    const rows = extra.rows ?? props.rows ?? makeRows();
    return (
      <DataGrid<Row>
        {...({
          gridId: "undo-test",
          columns,
          rows,
          getRowId: (row: Row) => row.id,
          total: rows.length,
          caption: "Undo grid",
          interaction: "sheet",
          ...props,
          ...extra,
        } as React.ComponentProps<typeof DataGrid<Row>>)}
      />
    );
  };
  const view = render(element());
  return { ...view, update: (extra: GridProps) => view.rerender(element(extra)) };
}

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const cellEl = (rowId: string, col: string) => rowEl(rowId).querySelector<HTMLElement>(`[data-col="${col}"]`)!;
function focusCell(rowId: string, col: string) {
  const cell = cellEl(rowId, col);
  act(() => cell.focus());
  return cell;
}
const key = (target: HTMLElement, init: KeyboardEventInit) => fireEvent.keyDown(target, init);
const pasteInto = (target: HTMLElement, text: string) =>
  fireEvent.paste(target, { clipboardData: { getData: () => text } });

/** Types a new title into a cell and commits with Enter. */
async function editTitle(rowId: string, value: string, saves: Saves) {
  const before = saves.title.mock.calls.length;
  key(focusCell(rowId, "title"), { key: "Enter" });
  const input = screen.getByTestId("grid-cell-input");
  fireEvent.change(input, { target: { value } });
  key(input, { key: "Enter" });
  await waitFor(() => expect(saves.title.mock.calls.length).toBe(before + 1));
}

const undoButton = () => screen.getByRole("button", { name: "Undo" });
const redoButton = () => screen.getByRole("button", { name: "Redo" });
const text = (rowId: string, col: string) => cellEl(rowId, col).textContent;

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

describe("undo / redo in sheet mode", () => {
  it("Ctrl+Z restores a single edit through the column's save and Ctrl+Y re-applies it", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    await editTitle("r1", "Renamed", saves);
    expect(text("r1", "title")).toBe("Renamed");

    key(focusCell("r2", "title"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(2));
    expect(saves.title.mock.calls[1][0].id).toBe("r1");
    expect(saves.title.mock.calls[1][1]).toBe("Dark mode");
    await waitFor(() => expect(text("r1", "title")).toBe("Dark mode"));

    key(focusCell("r2", "title"), { key: "y", ctrlKey: true });
    await waitFor(() => expect(saves.title).toHaveBeenCalledTimes(3));
    expect(saves.title.mock.calls[2][1]).toBe("Renamed");
    await waitFor(() => expect(text("r1", "title")).toBe("Renamed"));
  });

  it("Cmd+Z undoes and Shift+Cmd+Z redoes", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    await editTitle("r1", "Renamed", saves);

    key(focusCell("r1", "title"), { key: "z", metaKey: true });
    await waitFor(() => expect(text("r1", "title")).toBe("Dark mode"));
    key(focusCell("r1", "title"), { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(text("r1", "title")).toBe("Renamed"));
  });

  it("one paste is one undo step", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    pasteInto(focusCell("r1", "points"), "10\n20\n30");
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(3));

    key(focusCell("r1", "points"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(6));
    const replays = saves.points.mock.calls.slice(3).map(([row, next]) => [row.id, next] as const);
    expect(replays.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["r1", 1],
      ["r2", 2],
      ["r3", 3],
    ]);
    await waitFor(() => expect(text("r3", "points")).toBe("3"));
    // The whole paste is gone in one step; a second Ctrl+Z has nothing to undo.
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeEnabled();
  });

  it("a fill and a clear each undo as one step", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    // Fill r1's value down through r3.
    const cell = focusCell("r1", "points");
    key(cell, { key: "ArrowDown", shiftKey: true });
    key(cell, { key: "ArrowDown", shiftKey: true });
    key(cell, { key: "d", ctrlKey: true });
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(2));

    key(cell, { key: "z", ctrlKey: true });
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(text("r3", "points")).toBe("3"));
  });

  it("skips a cell that changed since and reports it, still restoring the rest", async () => {
    const saves = makeSaves();
    const view = mountSheet(saves);
    pasteInto(focusCell("r1", "points"), "10\n20\n30");
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(3));

    // The server re-delivers the page and someone else has set r2 to 99.
    const delivered = makeRows().map((row, index) => (index < 3 ? patch(row, { points: [10, 99, 30][index] }) : row));
    view.update({ rows: delivered });
    await waitFor(() => expect(text("r2", "points")).toBe("99"));

    key(focusCell("r1", "points"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(saves.points).toHaveBeenCalledTimes(5));
    expect(saves.points.mock.calls.slice(3).map(([row]) => row.id).sort()).toEqual(["r1", "r3"]);
    // r2 keeps the other user's value and is named in the notice.
    expect(text("r2", "points")).toBe("99");
    expect(screen.getByTestId("grid-range-notice")).toHaveTextContent("Undid 2 cells; 1 cell was skipped because it changed since.");
    expect(screen.getByTestId("grid-live-region")).toHaveTextContent("1 cell was skipped because it changed since");
  });

  it("does not write when every cell changed since, and drops the step", async () => {
    const saves = makeSaves();
    const view = mountSheet(saves);
    await editTitle("r1", "Mine", saves);
    view.update({ rows: makeRows().map((row) => (row.id === "r1" ? patch(row, { title: "Theirs" }) : row)) });
    await waitFor(() => expect(text("r1", "title")).toBe("Theirs"));

    key(focusCell("r1", "title"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("grid-range-notice")).toHaveTextContent("Undid 0 cells"));
    expect(saves.title).toHaveBeenCalledTimes(1);
    expect(text("r1", "title")).toBe("Theirs");
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeDisabled();
  });

  it("a new edit after an undo invalidates redo", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    await editTitle("r1", "First", saves);
    key(focusCell("r1", "title"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(text("r1", "title")).toBe("Dark mode"));
    expect(redoButton()).toBeEnabled();

    await editTitle("r2", "Second", saves);
    expect(redoButton()).toBeDisabled();
    key(focusCell("r1", "title"), { key: "y", ctrlKey: true });
    expect(saves.title).toHaveBeenCalledTimes(3);
  });

  it("rolls back and reports when the replay itself fails", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    await editTitle("r1", "Renamed", saves);
    saves.title.mockImplementationOnce(async () => ({ ok: false, error: "Title is locked" }));

    key(focusCell("r1", "title"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("grid-range-notice")).toHaveTextContent("1 could not be saved"));
    expect(text("r1", "title")).toBe("Renamed");
    expect(screen.getByTestId("grid-error-strip")).toHaveTextContent("Title is locked");
  });

  it("keeps the history across a re-delivery of rows, and clears it on a page change", async () => {
    const saves = makeSaves();
    const view = mountSheet(saves, { page: 1, pageSize: 4, total: 8 });
    await editTitle("r1", "Renamed", saves);
    expect(undoButton()).toBeEnabled();

    view.update({ rows: makeRows().map((row) => (row.id === "r1" ? patch(row, { title: "Renamed" }) : row)) });
    expect(undoButton()).toBeEnabled();

    view.update({ page: 2 });
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeDisabled();
  });

  it("clears the history when the sort changes", async () => {
    const saves = makeSaves();
    const view = mountSheet(saves, { sort: { key: "title", dir: "asc" } });
    await editTitle("r1", "Renamed", saves);
    expect(undoButton()).toBeEnabled();
    view.update({ sort: { key: "title", dir: "desc" } });
    expect(undoButton()).toBeDisabled();
  });

  it("clears the history when the search changes", async () => {
    const saves = makeSaves();
    const view = mountSheet(saves, { search: { value: "", onChange: () => {} } });
    await editTitle("r1", "Renamed", saves);
    view.update({ search: { value: "dark", onChange: () => {} } });
    expect(undoButton()).toBeDisabled();
  });

  it("history is per grid instance", async () => {
    const saves = makeSaves();
    const first = mountSheet(saves);
    await editTitle("r1", "Renamed", saves);
    first.unmount();
    mountSheet(makeSaves());
    expect(undoButton()).toBeDisabled();
  });

  it("does not undo while an editor is open (native text undo wins)", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    await editTitle("r1", "Renamed", saves);
    key(focusCell("r2", "title"), { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    key(input, { key: "z", ctrlKey: true });
    expect(saves.title).toHaveBeenCalledTimes(1);
    expect(text("r1", "title")).toBe("Renamed");
  });

  it("toolbar buttons undo and redo, and are named and disabled by state", async () => {
    const saves = makeSaves();
    mountSheet(saves);
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeDisabled();

    await editTitle("r1", "Renamed", saves);
    expect(undoButton()).toBeEnabled();
    fireEvent.click(undoButton());
    await waitFor(() => expect(text("r1", "title")).toBe("Dark mode"));
    await waitFor(() => expect(redoButton()).toBeEnabled());
    fireEvent.click(redoButton());
    await waitFor(() => expect(text("r1", "title")).toBe("Renamed"));
  });

  it("offers the buttons in the grid itself when the toolbar is hidden", async () => {
    const saves = makeSaves();
    mountSheet(saves, { toolbar: false });
    await editTitle("r1", "Renamed", saves);
    fireEvent.click(undoButton());
    await waitFor(() => expect(text("r1", "title")).toBe("Dark mode"));
  });

  it("reports every undo / redo through onChangeSet with its own source", async () => {
    const saves = makeSaves();
    const sets: GridChangeSet[] = [];
    mountSheet(saves, { onChangeSet: (set) => sets.push(set) });
    await editTitle("r1", "Renamed", saves);
    key(focusCell("r1", "title"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(sets.map((set) => set.source)).toEqual(["edit", "undo"]));
    expect(sets[1].changes[0]).toMatchObject({ rowId: "r1", prev: "Renamed", next: "Dark mode" });
  });

  it("is disabled in a read-only grid: no buttons, and Ctrl+Z writes nothing", () => {
    const saves = makeSaves();
    mountSheet(saves, { readOnly: true });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    key(focusCell("r1", "title"), { key: "z", ctrlKey: true });
    expect(saves.title).not.toHaveBeenCalled();
  });

  it("is absent outside sheet mode", () => {
    mountSheet(makeSaves(), { interaction: undefined });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("does not record rows that were never saved", async () => {
    const saves = makeSaves();
    saves.title.mockImplementation(async () => ({ ok: false, error: "No" }));
    mountSheet(saves);
    await editTitle("r1", "Rejected", saves);
    await waitFor(() => expect(screen.getByTestId("grid-error-strip")).toBeInTheDocument());
    expect(undoButton()).toBeDisabled();
  });
});
