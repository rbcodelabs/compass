// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DataGrid } from "@/components/data-grid/data-grid";
import type {
  GridActionResult,
  GridColumnDef,
} from "@/components/data-grid/types";

afterEach(cleanup);

// Rows nest their data on purpose: this is the Discovery shape, where a
// top-level `{ ...row, [field]: next }` writes the wrong place.
type Row = {
  id: string;
  data: { title: string; status: string; points: number | null; done: boolean };
};

const ROWS: Row[] = [
  { id: "r1", data: { title: "Dark mode", status: "OPEN", points: 3, done: false } },
  { id: "r2", data: { title: "Bulk export", status: "OPEN", points: null, done: true } },
  { id: "r3", data: { title: "Audit log", status: "PLANNED", points: 8, done: false } },
];

const STATUS_OPTIONS = [
  { value: "OPEN", label: "Open" },
  { value: "PLANNED", label: "Planned" },
] as const;

type SaveMock<V> = Mock<(row: Row, next: V) => Promise<GridActionResult>>;
type Saves = {
  title: SaveMock<string | null>;
  status: SaveMock<string>;
  points: SaveMock<number | null>;
  done: SaveMock<boolean>;
};

function makeSaves(): Saves {
  const ok = async (): Promise<GridActionResult> => ({ ok: true });
  return { title: vi.fn(ok), status: vi.fn(ok), points: vi.fn(ok), done: vi.fn(ok) };
}

function patch(row: Row, change: Partial<Row["data"]>): Row {
  return { ...row, data: { ...row.data, ...change } };
}

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
      cell: ({ row }) => <button type="button">{row.original.data.title}</button>,
    },
    {
      id: "readonly",
      header: "Note",
      meta: { label: "Note" },
      cell: () => <span>note</span>,
    },
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
          triggerLabel: (row) => `Status for ${row.data.title}`,
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
          triggerLabel: (row) => `Points for ${row.data.title}`,
          save: saves.points,
        },
      },
    },
    {
      id: "done",
      header: "Done",
      meta: {
        label: "Done",
        edit: {
          kind: "checkbox",
          field: "data",
          getValue: (row) => row.data.done,
          applyOptimistic: (row, next) => patch(row, { done: next }),
          triggerLabel: (row) => `Done for ${row.data.title}`,
          save: saves.done,
        },
      },
    },
  ];
}

type GridProps = Partial<React.ComponentProps<typeof DataGrid<Row>>>;

function renderSheet(saves: Saves, props: GridProps = {}) {
  const columns = props.columns ?? makeColumns(saves);
  const merged = {
    gridId: "sheet-test",
    columns,
    rows: ROWS,
    getRowId: (row: Row) => row.id,
    total: ROWS.length,
    caption: "Sheet grid",
    interaction: "sheet",
    ...props,
  } as React.ComponentProps<typeof DataGrid<Row>>;
  const utils = render(<DataGrid<Row> {...merged} />);
  return {
    ...utils,
    rerenderGrid: (next: GridProps = {}) =>
      utils.rerender(
        <DataGrid<Row>
          {...({ ...merged, ...next } as React.ComponentProps<typeof DataGrid<Row>>)}
        />,
      ),
  };
}

const rowEl = (id: string) =>
  document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const cellEl = (rowId: string, col: string) =>
  rowEl(rowId).querySelector<HTMLElement>(`[data-col="${col}"]`)!;

function focusCell(rowId: string, col: string) {
  const cell = cellEl(rowId, col);
  act(() => cell.focus());
  return cell;
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
});

describe("DataGrid interaction='sheet'", () => {
  describe("semantics", () => {
    it("renders a labelled grid with server-total rowcount and row indexes", () => {
      renderSheet(makeSaves(), { total: 40, page: 2, pageSize: 3 });
      const grid = screen.getByRole("grid", { name: "Sheet grid" });
      // 40 server rows plus the header row.
      expect(grid).toHaveAttribute("aria-rowcount", "41");
      expect(grid).toHaveAttribute("aria-colcount", "5");
      // Page 2 of size 3: header is 1, so the first body row is 2 + 3.
      expect(rowEl("r1")).toHaveAttribute("aria-rowindex", "5");
      expect(rowEl("r3")).toHaveAttribute("aria-rowindex", "7");
    });

    it("is one tab stop: exactly one gridcell has tabindex 0", () => {
      renderSheet(makeSaves());
      const stops = screen
        .getAllByRole("gridcell")
        .filter((cell) => cell.getAttribute("tabindex") === "0");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toBe(cellEl("r1", "title"));
    });

    it("takes widgets inside cells out of the tab order", () => {
      renderSheet(makeSaves());
      expect(within(cellEl("r1", "title")).getByRole("button")).toHaveAttribute(
        "tabindex",
        "-1",
      );
    });

    it("marks non-editable cells aria-readonly", () => {
      renderSheet(makeSaves());
      expect(cellEl("r1", "readonly")).toHaveAttribute("aria-readonly", "true");
      expect(cellEl("r1", "title")).toHaveAttribute("aria-readonly", "false");
    });
  });

  describe("navigation", () => {
    it("arrows move focus and the roving tabindex", () => {
      renderSheet(makeSaves());
      const start = focusCell("r1", "title");
      fireEvent.keyDown(start, { key: "ArrowDown" });
      expect(cellEl("r2", "title")).toHaveFocus();
      expect(cellEl("r2", "title")).toHaveAttribute("tabindex", "0");
      expect(cellEl("r1", "title")).toHaveAttribute("tabindex", "-1");

      fireEvent.keyDown(cellEl("r2", "title"), { key: "ArrowRight" });
      expect(cellEl("r2", "readonly")).toHaveFocus();
    });

    it("stops at the edges", () => {
      renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "ArrowUp" });
      expect(cellEl("r1", "title")).toHaveFocus();
      fireEvent.keyDown(cellEl("r1", "title"), { key: "ArrowLeft" });
      expect(cellEl("r1", "title")).toHaveFocus();
    });

    it("Tab skips non-editable cells, and leaves the grid at the last editable cell", () => {
      renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Tab" });
      expect(cellEl("r1", "status")).toHaveFocus();

      const last = focusCell("r3", "done");
      const notPrevented = fireEvent.keyDown(last, { key: "Tab" });
      // Not prevented: the browser moves focus out, so the grid is no trap.
      expect(notPrevented).toBe(true);
    });

    it("Ctrl+End and Home jump to the corners of the grid and row", () => {
      renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "End", ctrlKey: true });
      expect(cellEl("r3", "done")).toHaveFocus();
      fireEvent.keyDown(cellEl("r3", "done"), { key: "Home" });
      expect(cellEl("r3", "title")).toHaveFocus();
    });

    it("focus survives an RSC re-delivery of identical rows", () => {
      const { rerenderGrid } = renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "ArrowDown" });
      rerenderGrid({ rows: ROWS.map((row) => ({ ...row })) });
      expect(cellEl("r2", "title")).toHaveFocus();
      expect(cellEl("r2", "title")).toHaveAttribute("tabindex", "0");
    });

    it("falls back to the nearest row when the active row disappears", () => {
      const { rerenderGrid } = renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "End", ctrlKey: true });
      rerenderGrid({ rows: ROWS.slice(0, 2), total: 2 });
      const stops = screen
        .getAllByRole("gridcell")
        .filter((cell) => cell.getAttribute("tabindex") === "0");
      expect(stops).toHaveLength(1);
      expect(stops[0].closest("tr")).toBe(rowEl("r2"));
    });

    it("clicking a cell makes it the tab stop without stealing focus elsewhere", () => {
      renderSheet(makeSaves());
      focusCell("r3", "status");
      expect(cellEl("r3", "status")).toHaveAttribute("tabindex", "0");
      expect(cellEl("r1", "title")).toHaveAttribute("tabindex", "-1");
    });
  });

  describe("text editing", () => {
    it("Enter opens an editor seeded with the value; Enter commits and moves down", async () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });

      const input = screen.getByLabelText("Title for Dark mode");
      expect(input).toHaveValue("Dark mode");
      expect(input).toHaveFocus();

      fireEvent.change(input, { target: { value: "Dark mode v2" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(saves.title).toHaveBeenCalledTimes(1);
      expect(saves.title.mock.calls[0][1]).toBe("Dark mode v2");
      // Moved down, editor gone.
      await waitFor(() => expect(cellEl("r2", "title")).toHaveFocus());
      expect(screen.queryByTestId("grid-cell-input")).toBeNull();
    });

    it("writes the nested row through applyOptimistic", async () => {
      renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      const input = screen.getByTestId("grid-cell-input");
      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(within(cellEl("r1", "title")).getByRole("button")).toHaveTextContent(
        "Renamed",
      );
    });

    it("typing a character starts an edit that replaces the content", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "q" });
      expect(screen.getByTestId("grid-cell-input")).toHaveValue("q");
    });

    it("F2 edits, double-click edits", () => {
      renderSheet(makeSaves());
      fireEvent.keyDown(focusCell("r1", "title"), { key: "F2" });
      expect(screen.getByTestId("grid-cell-input")).toHaveValue("Dark mode");
      fireEvent.keyDown(screen.getByTestId("grid-cell-input"), { key: "Escape" });

      fireEvent.doubleClick(cellEl("r2", "title"));
      expect(screen.getByLabelText("Title for Bulk export")).toBeInTheDocument();
    });

    it("Escape restores the value, saves nothing and returns focus to the cell", async () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      const input = screen.getByTestId("grid-cell-input");
      fireEvent.change(input, { target: { value: "Throwaway" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(saves.title).not.toHaveBeenCalled();
      expect(screen.queryByTestId("grid-cell-input")).toBeNull();
      await waitFor(() => expect(cellEl("r1", "title")).toHaveFocus());
      expect(within(cellEl("r1", "title")).getByRole("button")).toHaveTextContent(
        "Dark mode",
      );
    });

    it("an unchanged value is not saved", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      fireEvent.keyDown(screen.getByTestId("grid-cell-input"), { key: "Enter" });
      expect(saves.title).not.toHaveBeenCalled();
    });

    it("blurring the editor commits it, once", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      const input = screen.getByTestId("grid-cell-input");
      fireEvent.change(input, { target: { value: "Via blur" } });
      fireEvent.blur(input);
      expect(saves.title).toHaveBeenCalledTimes(1);
    });

    it("Tab commits and moves to the next editable cell", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      const input = screen.getByTestId("grid-cell-input");
      fireEvent.change(input, { target: { value: "Tabbed" } });
      fireEvent.keyDown(input, { key: "Tab" });
      expect(saves.title).toHaveBeenCalledTimes(1);
      expect(cellEl("r1", "status")).toHaveFocus();
    });

    it("an unparseable value keeps the editor open, flags it and saves nothing", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "points"), { key: "Enter" });
      const input = screen.getByLabelText("Points for Dark mode");
      fireEvent.change(input, { target: { value: "lots" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(saves.points).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Points for Dark mode")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(screen.getByTestId("grid-live-region")).toHaveTextContent("Enter a number");
    });

    it("Delete clears an editable cell through parse('')", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "points"), { key: "Delete" });
      expect(saves.points).toHaveBeenCalledTimes(1);
      expect(saves.points.mock.calls[0][1]).toBeNull();
    });

    it("typing numbers parses to a number", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r2", "points"), { key: "5" });
      const input = screen.getByTestId("grid-cell-input");
      expect(input).toHaveValue("5");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(saves.points.mock.calls[0][1]).toBe(5);
    });
  });

  describe("failed saves", () => {
    it("rolls back the nested row and shows the inline error", async () => {
      const saves = makeSaves();
      saves.title.mockResolvedValue({ ok: false, error: "Title is taken" });
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      const input = screen.getByTestId("grid-cell-input");
      fireEvent.change(input, { target: { value: "Nope" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() =>
        expect(screen.getByTestId("grid-error-strip")).toHaveTextContent("Title is taken"),
      );
      expect(within(cellEl("r1", "title")).getByRole("button")).toHaveTextContent(
        "Dark mode",
      );
      expect(cellEl("r1", "title")).toHaveAttribute("aria-invalid", "true");
    });
  });

  describe("checkbox", () => {
    it("Space and Enter toggle in place", () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "done"), { key: " " });
      expect(saves.done.mock.calls[0][1]).toBe(true);
      fireEvent.keyDown(cellEl("r2", "done"), { key: "Enter" });
      focusCell("r2", "done");
      fireEvent.keyDown(cellEl("r2", "done"), { key: "Enter" });
      expect(saves.done.mock.calls.at(-1)?.[1]).toBe(false);
    });
  });

  describe("select", () => {
    it("Enter opens the listbox; choosing an option commits it", async () => {
      const saves = makeSaves();
      renderSheet(saves);
      fireEvent.keyDown(focusCell("r1", "status"), { key: "Enter" });
      const option = await screen.findByRole("option", { name: "Planned" });
      // base-ui commits on the pointer sequence; a bare click does not.
      await act(async () => {
        fireEvent.pointerDown(option, { pointerId: 1, button: 0, isPrimary: true });
        fireEvent.pointerUp(option, { pointerId: 1, button: 0, isPrimary: true });
        fireEvent.click(option);
      });
      await waitFor(() => expect(saves.status).toHaveBeenCalledTimes(1));
      expect(saves.status.mock.calls[0][1]).toBe("PLANNED");
    });
  });

  describe("detail panel", () => {
    it("Alt+Enter calls onOpenRow instead of editing", () => {
      const onOpenRow = vi.fn();
      renderSheet(makeSaves(), { onOpenRow });
      fireEvent.keyDown(focusCell("r2", "title"), { key: "Enter", altKey: true });
      expect(onOpenRow).toHaveBeenCalledTimes(1);
      expect(onOpenRow.mock.calls[0][0].id).toBe("r2");
      expect(screen.queryByTestId("grid-cell-input")).toBeNull();
    });

    it("clicking the in-cell button keeps its own behaviour", () => {
      const onClick = vi.fn();
      const columns = makeColumns(makeSaves());
      columns[0] = {
        ...columns[0],
        cell: ({ row }) => (
          <button type="button" onClick={onClick}>
            {row.original.data.title}
          </button>
        ),
      };
      renderSheet(makeSaves(), { columns });
      fireEvent.click(within(cellEl("r1", "title")).getByRole("button"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("readOnly", () => {
    it("navigates but never edits, and flags every cell aria-readonly", () => {
      const saves = makeSaves();
      renderSheet(saves, { readOnly: true });
      expect(cellEl("r1", "title")).toHaveAttribute("aria-readonly", "true");

      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter" });
      fireEvent.keyDown(cellEl("r1", "title"), { key: "x" });
      fireEvent.doubleClick(cellEl("r1", "title"));
      expect(screen.queryByTestId("grid-cell-input")).toBeNull();

      fireEvent.keyDown(focusCell("r1", "done"), { key: " " });
      fireEvent.keyDown(cellEl("r1", "points"), { key: "Delete" });
      expect(saves.done).not.toHaveBeenCalled();
      expect(saves.points).not.toHaveBeenCalled();

      fireEvent.keyDown(focusCell("r1", "title"), { key: "ArrowDown" });
      expect(cellEl("r2", "title")).toHaveFocus();
    });

    it("still allows Alt+Enter to open the detail panel", () => {
      const onOpenRow = vi.fn();
      renderSheet(makeSaves(), { readOnly: true, onOpenRow });
      fireEvent.keyDown(focusCell("r1", "title"), { key: "Enter", altKey: true });
      expect(onOpenRow).toHaveBeenCalledTimes(1);
    });
  });
});

describe("DataGrid without interaction (legacy)", () => {
  it("adds no grid semantics, tab stops or listeners-driven attributes", () => {
    renderSheet(makeSaves(), { interaction: undefined });
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
    const cell = cellEl("r1", "title");
    expect(cell).not.toHaveAttribute("tabindex");
    expect(cell).not.toHaveAttribute("role");
    expect(cell).not.toHaveAttribute("aria-colindex");
    expect(rowEl("r1")).not.toHaveAttribute("aria-rowindex");
  });

  it("keeps the always-mounted select trigger and ignores non-select edits", () => {
    renderSheet(makeSaves(), { interaction: undefined });
    expect(screen.getByLabelText("Status for Dark mode")).toBeInTheDocument();
    // The text/number/checkbox columns fall back to their display cells.
    expect(screen.queryByLabelText("Points for Dark mode")).toBeNull();
    fireEvent.keyDown(cellEl("r1", "title"), { key: "Enter" });
    expect(screen.queryByTestId("grid-cell-input")).toBeNull();
  });

  it("readOnly renders the select as static text", () => {
    renderSheet(makeSaves(), { interaction: undefined, readOnly: true });
    expect(screen.queryByLabelText("Status for Dark mode")).toBeNull();
    expect(within(cellEl("r1", "status")).getByText("Open")).toBeInTheDocument();
  });
});
