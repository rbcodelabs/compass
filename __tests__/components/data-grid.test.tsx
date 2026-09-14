// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  gridPreferencesKey,
  reconcilePreferences,
  readStoredPreferences,
} from "@/components/data-grid/use-grid-preferences";
import type {
  GridActionResult,
  GridColumnDef,
} from "@/components/data-grid/types";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
type Row = { id: string; title: string; status: string; votes: number };

const SERVER_A: Row[] = [
  { id: "r1", title: "Dark mode", status: "OPEN", votes: 12 },
  { id: "r2", title: "Bulk export", status: "OPEN", votes: 5 },
];

/** A fresh array of fresh objects with IDENTICAL content: pure RSC identity churn. */
function churn(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...row }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const STATUS_OPTIONS = [
  { value: "OPEN", label: "Open" },
  { value: "PLANNED", label: "Planned" },
] as const;

function makeColumns(
  save: (row: Row, next: string) => Promise<GridActionResult>,
): GridColumnDef<Row>[] {
  return [
    {
      id: "title",
      header: "Title",
      accessorKey: "title",
      meta: { label: "Title", sortable: true, sortKey: "title", width: "20rem" },
    },
    {
      id: "status",
      header: "Status",
      accessorKey: "status",
      meta: {
        label: "Status",
        sortable: true,
        sortKey: "status",
        width: "10rem",
        edit: {
          kind: "select",
          options: STATUS_OPTIONS,
          field: "status",
          getValue: (row) => row.status,
          triggerLabel: (row) => `Status for ${row.title}`,
          save,
        },
      },
    },
    {
      id: "votes",
      header: "Votes",
      accessorKey: "votes",
      meta: { label: "Votes", sortable: true, sortKey: "votes", align: "end" },
    },
    {
      id: "action",
      header: "Action",
      // Not a data column: never hidden, never reordered.
      meta: { label: "Action", hideable: false, width: "8rem" },
      cell: () => <span data-testid="action-cell">Promote</span>,
    },
  ];
}

const noopSave = async (): Promise<GridActionResult> => ({ ok: true });

type GridProps = Partial<React.ComponentProps<typeof DataGrid<Row>>>;

function renderGrid(props: GridProps = {}) {
  const columns = props.columns ?? makeColumns(noopSave);
  const merged = {
    gridId: "test",
    columns,
    rows: SERVER_A,
    getRowId: (row: Row) => row.id,
    total: SERVER_A.length,
    page: 1,
    pageSize: 25,
    caption: "Test grid",
    ...props,
  } as React.ComponentProps<typeof DataGrid<Row>>;
  const utils = render(<DataGrid<Row> {...merged} />);
  return {
    ...utils,
    rerenderGrid: (next: GridProps = {}) =>
      utils.rerender(
        <DataGrid<Row> {...({ ...merged, ...next } as React.ComponentProps<typeof DataGrid<Row>>)} />,
      ),
  };
}

/** jsdom has no matchMedia; the grid's useIsMobile depends on it. */
function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: mobile,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/**
 * This jsdom environment does not ship a usable `localStorage`, so the grid's
 * preference persistence needs a real Storage-shaped object to write to.
 */
function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}

beforeEach(() => {
  installLocalStorage();
  setViewport(false);
});

// ---------------------------------------------------------------------------
// Rendering + sorting
// ---------------------------------------------------------------------------
describe("DataGrid rendering", () => {
  it("renders the documented E2E hooks on rows, cells and headers", () => {
    renderGrid();

    const rows = screen.getAllByTestId("grid-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-row-id", "r1");
    expect(rows[1]).toHaveAttribute("data-row-id", "r2");

    expect(screen.getByTestId("grid-head-title")).toHaveAttribute("data-col", "title");
    expect(screen.getByTestId("grid-head-votes")).toHaveAttribute("data-col", "votes");

    const cell = within(rows[0]).getByTestId("grid-cell-title");
    expect(cell).toHaveAttribute("data-col", "title");
    expect(cell).toHaveTextContent("Dark mode");
    expect(within(rows[0]).getByTestId("grid-cell-votes")).toHaveTextContent("12");
    expect(within(rows[1]).getByTestId("action-cell")).toBeInTheDocument();
  });

  it("renders an sr-only caption and a polite live region", () => {
    renderGrid();
    expect(screen.getByTestId("grid-live-region")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    const caption = document.querySelector("caption");
    expect(caption).toHaveTextContent("Test grid");
    expect(caption).toHaveClass("sr-only");
  });

  it("emits one <col> per visible column with a stable declared width", () => {
    renderGrid();
    const cols = Array.from(document.querySelectorAll("colgroup col"));
    expect(cols).toHaveLength(4);
    expect((cols[0] as HTMLElement).style.width).toBe("20rem");
    expect((cols[1] as HTMLElement).style.width).toBe("10rem");
    expect((cols[3] as HTMLElement).style.width).toBe("8rem");
  });

  it("shows the empty state when the server page is empty", () => {
    renderGrid({ rows: [], total: 0, emptyState: <span>Nothing here</span> });
    expect(screen.queryAllByTestId("grid-row")).toHaveLength(0);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("does not adopt role=grid (no roving arrow-key navigation ships)", () => {
    renderGrid();
    expect(document.querySelector('[role="grid"]')).toBeNull();
  });
});

describe("DataGrid sorting", () => {
  it("sets aria-sort on the sorted header and 'none' on the others", () => {
    renderGrid({ sort: { key: "votes", dir: "desc" } });
    expect(screen.getByTestId("grid-head-votes")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByTestId("grid-head-title")).toHaveAttribute("aria-sort", "none");
    expect(screen.getByTestId("grid-head-status")).toHaveAttribute("aria-sort", "none");
  });

  it("reports ascending when the sort direction is asc", () => {
    renderGrid({ sort: { key: "title", dir: "asc" } });
    expect(screen.getByTestId("grid-head-title")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("omits aria-sort entirely on a non-sortable column", () => {
    renderGrid();
    expect(screen.getByTestId("grid-head-action")).not.toHaveAttribute("aria-sort");
  });

  it("uses a real focusable Button for the sort toggle and emits the sort KEY", () => {
    const onSortChange = vi.fn();
    renderGrid({ sort: { key: "votes", dir: "desc" }, onSortChange });

    const head = screen.getByTestId("grid-head-title");
    const button = within(head).getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);

    // The direction is deliberately NOT decided here: the caller's serializer
    // owns it.
    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenCalledWith("title");
  });

  it("announces a sort change in the live region, but not on first render", async () => {
    const { rerenderGrid } = renderGrid({ total: 42 });
    expect(screen.getByTestId("grid-live-region")).toHaveTextContent("");

    rerenderGrid({ total: 42, sort: { key: "status", dir: "desc" } });
    await waitFor(() =>
      expect(screen.getByTestId("grid-live-region")).toHaveTextContent(
        "Sorted by Status, descending. 42 results.",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Column visibility
// ---------------------------------------------------------------------------
describe("DataGrid column visibility", () => {
  async function openColumnsMenu() {
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await screen.findByTestId("grid-column-toggle-title");
  }

  it("hides and re-shows a column from the column menu", async () => {
    renderGrid();
    expect(screen.getByTestId("grid-head-status")).toBeInTheDocument();

    // A checkbox item does not close the menu, so it stays open between toggles.
    await openColumnsMenu();
    fireEvent.click(screen.getByTestId("grid-column-toggle-status"));

    await waitFor(() =>
      expect(screen.queryByTestId("grid-head-status")).not.toBeInTheDocument(),
    );
    // the cells go with it
    expect(screen.queryAllByTestId("grid-cell-status")).toHaveLength(0);
    // ...and the other columns are untouched
    expect(screen.getByTestId("grid-head-title")).toBeInTheDocument();
    expect(screen.getAllByTestId("grid-cell-title")).toHaveLength(2);
    expect(document.querySelectorAll("colgroup col")).toHaveLength(3);

    fireEvent.click(screen.getByTestId("grid-column-toggle-status"));
    await waitFor(() =>
      expect(screen.getByTestId("grid-head-status")).toBeInTheDocument(),
    );
    expect(document.querySelectorAll("colgroup col")).toHaveLength(4);
  });

  it("does not offer a non-hideable column for hiding", async () => {
    renderGrid();
    await openColumnsMenu();
    // base-ui menu items express disabled state with aria-disabled/data-disabled
    // rather than the `disabled` attribute (they are divs, not buttons).
    const item = screen.getByTestId("grid-column-toggle-action");
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAttribute("data-disabled");

    // Clicking it changes nothing.
    fireEvent.click(item);
    expect(screen.getByTestId("grid-head-action")).toBeInTheDocument();
  });

  it("persists hidden columns to localStorage under compass:grid:{id}:v1", async () => {
    renderGrid({ gridId: "feedback" });
    await openColumnsMenu();
    fireEvent.click(screen.getByTestId("grid-column-toggle-votes"));

    await waitFor(() =>
      expect(screen.queryByTestId("grid-head-votes")).not.toBeInTheDocument(),
    );
    const raw = window.localStorage.getItem("compass:grid:feedback:v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).hidden).toEqual(["votes"]);
  });

  it("reads stored preferences after mount, never during render", async () => {
    window.localStorage.setItem(
      gridPreferencesKey("feedback"),
      JSON.stringify({ hidden: ["votes"], order: ["status", "title"] }),
    );
    renderGrid({ gridId: "feedback" });

    await waitFor(() =>
      expect(screen.queryByTestId("grid-head-votes")).not.toBeInTheDocument(),
    );
    const heads = Array.from(document.querySelectorAll("th")).map((th) =>
      th.getAttribute("data-col"),
    );
    // stored order applied; the pinned `action` column keeps its declared slot
    expect(heads).toEqual(["status", "title", "action"]);
  });
});

// ---------------------------------------------------------------------------
// Preference reconciliation (pure)
// ---------------------------------------------------------------------------
describe("grid preference reconciliation", () => {
  const columns = [
    { id: "title" },
    { id: "status" },
    { id: "votes" },
    { id: "action", hideable: false },
  ];

  it("defaults to the declared order with nothing hidden", () => {
    expect(reconcilePreferences(null, columns)).toEqual({
      columnOrder: ["title", "status", "votes", "action"],
      columnVisibility: {},
    });
  });

  it("drops unknown ids and appends new ones", () => {
    const result = reconcilePreferences(
      { hidden: ["gone", "votes"], order: ["votes", "gone", "title"] },
      columns,
    );
    // "gone" dropped; "status" (new since the preference was saved) appended
    expect(result.columnOrder).toEqual(["votes", "title", "status", "action"]);
    expect(result.columnVisibility).toEqual({ votes: false });
  });

  it("ignores attempts to hide or move a hideable:false column", () => {
    const result = reconcilePreferences(
      { hidden: ["action"], order: ["action", "title", "status", "votes"] },
      columns,
    );
    expect(result.columnVisibility).toEqual({});
    // `action` stays in its declared final slot
    expect(result.columnOrder[3]).toBe("action");
    expect(result.columnOrder).toHaveLength(4);
  });

  it("resets on corrupt JSON instead of throwing", () => {
    window.localStorage.setItem(gridPreferencesKey("broken"), "{not json");
    expect(() => readStoredPreferences("broken")).not.toThrow();
    expect(readStoredPreferences("broken")).toBeNull();
    expect(reconcilePreferences(readStoredPreferences("broken"), columns)).toEqual({
      columnOrder: ["title", "status", "votes", "action"],
      columnVisibility: {},
    });
  });

  it("rejects a stored value of the wrong shape", () => {
    window.localStorage.setItem(gridPreferencesKey("weird"), JSON.stringify([1, 2]));
    expect(readStoredPreferences("weird")).toBeNull();
    window.localStorage.setItem(
      gridPreferencesKey("weird2"),
      JSON.stringify({ hidden: "votes", order: 3 }),
    );
    expect(readStoredPreferences("weird2")).toEqual({ hidden: [], order: [] });
  });
});

// ---------------------------------------------------------------------------
// Optimistic overlay: the four behaviours
// ---------------------------------------------------------------------------
describe("DataGrid optimistic overlay", () => {
  function statusText(rowId: string) {
    const row = screen
      .getAllByTestId("grid-row")
      .find((candidate) => candidate.getAttribute("data-row-id") === rowId);
    return within(row as HTMLElement).getByTestId("grid-cell-status");
  }

  /**
   * Drive the base-ui Select the way a pointer really does.
   *
   * Verified against `@base-ui/react`: a bare `fireEvent.click` on an option
   * does NOT commit a value, and neither does a mouse-event sequence. base-ui
   * commits on the pointer sequence, so that is what these tests dispatch.
   */
  async function editStatus(rowTitle: string, optionLabel: string) {
    await act(async () => {
      fireEvent.click(screen.getByLabelText(`Status for ${rowTitle}`));
    });
    const options = await screen.findAllByRole("option");
    const option = options.find((candidate) =>
      candidate.textContent?.includes(optionLabel),
    );
    expect(option, `option "${optionLabel}" should be in the listbox`).toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(option as HTMLElement, {
        pointerId: 1,
        button: 0,
        isPrimary: true,
      });
      fireEvent.pointerUp(option as HTMLElement, {
        pointerId: 1,
        button: 0,
        isPrimary: true,
      });
      fireEvent.click(option as HTMLElement);
    });
  }

  it("1. applies the edit optimistically BEFORE the action resolves", async () => {
    const d = deferred<GridActionResult>();
    const save = vi.fn(() => d.promise);
    renderGrid({ columns: makeColumns(save) });

    expect(statusText("r1")).toHaveTextContent("Open");

    await editStatus("Dark mode", "Planned");

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1" }),
      "PLANNED",
    );
    // optimistic value is on screen while the write is still in flight
    expect(statusText("r1")).toHaveTextContent("Planned");
    expect(
      screen.getAllByTestId("grid-row")[0],
    ).toHaveAttribute("data-pending", "true");
    // the untouched row is unaffected
    expect(statusText("r2")).toHaveTextContent("Open");

    await act(async () => {
      d.resolve({ ok: true });
    });
    expect(statusText("r1")).toHaveTextContent("Planned");
    expect(screen.getAllByTestId("grid-row")[0]).not.toHaveAttribute("data-pending");
  });

  it("2. rolls back and surfaces an inline error when the action fails", async () => {
    const d = deferred<GridActionResult>();
    const save = vi.fn(() => d.promise);
    renderGrid({ columns: makeColumns(save) });

    await editStatus("Dark mode", "Planned");
    expect(statusText("r1")).toHaveTextContent("Planned");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      d.resolve({ ok: false, error: "You do not have permission." });
    });

    // reverted to the server value
    expect(statusText("r1")).toHaveTextContent("Open");
    // marked on the cell
    const cell = statusText("r1");
    expect(cell).toHaveAttribute("data-error", "true");
    expect(cell).toHaveAttribute("aria-invalid", "true");
    // ...and announced in a role="alert" strip. No toast library is used.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("You do not have permission.");
    expect(screen.getByTestId("grid-error-strip")).toBe(alert);

    // the strip is dismissible
    fireEvent.click(screen.getByTestId("grid-error-dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("grid-error-strip")).not.toBeInTheDocument(),
    );
  });

  it("3. stay-and-mark: an edit out of the active filter keeps the row and shows the strip", async () => {
    const d = deferred<GridActionResult>();
    const save = vi.fn(() => d.promise);
    const onRefresh = vi.fn();
    renderGrid({
      columns: makeColumns(save),
      rowMatchesFilters: (row) => row.status === "OPEN",
      onRefresh,
    });

    expect(screen.queryByTestId("grid-stale-strip")).not.toBeInTheDocument();

    await editStatus("Dark mode", "Planned");
    // NOT stale while in flight: the write may still fail
    expect(
      screen.getAllByTestId("grid-row")[0].getAttribute("data-stale"),
    ).toBeNull();

    await act(async () => {
      d.resolve({ ok: true });
    });

    const rows = screen.getAllByTestId("grid-row");
    // The row must NOT disappear: removing it would desync the server-side
    // total and every later page's offsets.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-row-id", "r1");
    expect(rows[0]).toHaveAttribute("data-stale", "true");
    expect(rows[1]).not.toHaveAttribute("data-stale");

    const strip = screen.getByTestId("grid-stale-strip");
    expect(strip).toHaveTextContent("1 item no longer matches your filters");
    fireEvent.click(screen.getByTestId("grid-refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("3b. pluralises the stale strip", async () => {
    const save = vi.fn(async () => ({ ok: true }) as GridActionResult);
    renderGrid({
      columns: makeColumns(save),
      rowMatchesFilters: (row) => row.status === "OPEN",
    });

    for (const title of ["Dark mode", "Bulk export"]) {
      await editStatus(title, "Planned");
    }
    await waitFor(() =>
      expect(screen.getByTestId("grid-stale-strip")).toHaveTextContent(
        "2 items no longer match your filters",
      ),
    );
  });

  it("4. server wins: new rows drop settled overrides, stale marks and errors", async () => {
    const save = vi.fn(async () => ({ ok: true }) as GridActionResult);
    const columns = makeColumns(save);
    const { rerenderGrid } = renderGrid({
      columns,
      rowMatchesFilters: (row) => row.status === "OPEN",
    });

    await editStatus("Dark mode", "Planned");
    expect(statusText("r1")).toHaveTextContent("Planned");
    expect(screen.getByTestId("grid-stale-strip")).toBeInTheDocument();

    // The refresh returns post-write server truth: r1 is off the OPEN page.
    rerenderGrid({
      columns,
      rows: [{ id: "r2", title: "Bulk export", status: "OPEN", votes: 5 }],
      total: 1,
      rowMatchesFilters: (row: Row) => row.status === "OPEN",
    });

    expect(screen.getAllByTestId("grid-row")).toHaveLength(1);
    expect(screen.queryByTestId("grid-stale-strip")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("4b. server wins even when it contradicts a settled override", async () => {
    const save = vi.fn(async () => ({ ok: true }) as GridActionResult);
    const columns = makeColumns(save);
    const { rerenderGrid } = renderGrid({ columns });

    await editStatus("Dark mode", "Planned");
    expect(statusText("r1")).toHaveTextContent("Planned");

    rerenderGrid({
      columns,
      rows: [{ id: "r1", title: "Dark mode", status: "OPEN", votes: 12 }],
      total: 1,
    });
    expect(statusText("r1")).toHaveTextContent("Open");
  });

  it("REGRESSION: RSC identity churn does NOT wipe an in-flight edit", async () => {
    const d = deferred<GridActionResult>();
    const save = vi.fn(() => d.promise);
    const columns = makeColumns(save);
    const { rerenderGrid } = renderGrid({ columns });

    await editStatus("Dark mode", "Planned");
    expect(statusText("r1")).toHaveTextContent("Planned");

    // `revalidatePath` inside the still-pending action re-delivers the RSC
    // payload: same content, new identity, PRE-write. A naive
    // useEffect-on-rows reset wipes the edit permanently here.
    rerenderGrid({ columns, rows: churn(SERVER_A) });
    expect(statusText("r1")).toHaveTextContent("Planned");
    expect(screen.getAllByTestId("grid-row")[0]).toHaveAttribute(
      "data-pending",
      "true",
    );

    await act(async () => {
      d.resolve({ ok: true });
    });
    expect(statusText("r1")).toHaveTextContent("Planned");
  });

  it("REGRESSION: survives React.StrictMode double-invocation", async () => {
    const d = deferred<GridActionResult>();
    const save = vi.fn(() => d.promise);
    const columns = makeColumns(save);
    const base = {
      gridId: "strict",
      columns,
      getRowId: (row: Row) => row.id,
      total: 2,
      page: 1,
      pageSize: 25,
      caption: "Strict grid",
    };
    const { rerender } = render(
      <React.StrictMode>
        <DataGrid<Row> {...base} rows={SERVER_A} />
      </React.StrictMode>,
    );

    await editStatus("Dark mode", "Planned");
    expect(statusText("r1")).toHaveTextContent("Planned");

    rerender(
      <React.StrictMode>
        <DataGrid<Row> {...base} rows={churn(SERVER_A)} />
      </React.StrictMode>,
    );
    expect(statusText("r1")).toHaveTextContent("Planned");

    await act(async () => {
      d.resolve({ ok: true });
    });
    expect(statusText("r1")).toHaveTextContent("Planned");
  });
});

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------
describe("DataGrid mobile renderer", () => {
  const renderMobileRow = (row: Row) => (
    <div data-testid="mobile-card">
      <strong>{row.title}</strong>
      <span>{row.status}</span>
    </div>
  );

  it("uses the column layout above md", () => {
    setViewport(false);
    renderGrid({ renderMobileRow });
    expect(screen.getByTestId("grid-head-title")).toBeInTheDocument();
    expect(screen.queryAllByTestId("mobile-card")).toHaveLength(0);
    expect(screen.getAllByTestId("grid-cell-title")).toHaveLength(2);
  });

  it("swaps to stacked cards below md while staying a real table", () => {
    setViewport(true);
    renderGrid({ renderMobileRow });

    // cards rendered
    expect(screen.getAllByTestId("mobile-card")).toHaveLength(2);
    // the column layout is gone
    expect(screen.queryByTestId("grid-head-title")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("grid-cell-title")).toHaveLength(0);

    // but the DOM is still a table with the same row hooks
    const rows = screen.getAllByTestId("grid-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-row-id", "r1");
    expect(rows[0].tagName).toBe("TR");
    const cell = within(rows[0]).getByTestId("grid-cell-mobile");
    expect(cell.tagName).toBe("TD");

    // DELIBERATE CHANGE (was colspan="4", i.e. the desktop column count).
    //
    // In mobile mode the table genuinely has ONE column: every row is a single
    // stacked card. Spanning the desktop column count also kept the desktop
    // `<colgroup>` alive, and those fixed `<col>` widths sum to more than a
    // phone viewport — measured in a real browser at 390x844, a 704px table
    // inside a 358px container, i.e. exactly the horizontal scroll the stacked
    // card layout exists to eliminate. One column, one `<col>`, no overflow.
    expect(cell).toHaveAttribute("colspan", "1");
    const cols = document.querySelectorAll("colgroup col");
    expect(cols).toHaveLength(1);
    expect(cols[0].getAttribute("style")).toBeNull();

    expect(document.querySelector("table")).toBeInTheDocument();
  });

  it("keeps the column layout below md when no mobile renderer is supplied", () => {
    setViewport(true);
    renderGrid();
    expect(screen.getByTestId("grid-head-title")).toBeInTheDocument();
    expect(screen.queryByTestId("grid-cell-mobile")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
describe("DataGrid pagination", () => {
  it("derives page math from the SERVER total, not the page length", () => {
    renderGrid({ total: 57, page: 1, pageSize: 25 });
    expect(screen.getByTestId("grid-page-indicator")).toHaveTextContent(
      "Page 1 of 3",
    );
    expect(screen.getByTestId("grid-pagination-summary")).toHaveTextContent(
      "1–25 of 57 results",
    );
  });

  it("wraps the controls in a labelled nav", () => {
    renderGrid({ total: 57 });
    expect(
      screen.getByRole("navigation", { name: "Pagination" }),
    ).toBeInTheDocument();
  });

  it("uses aria-disabled, not disabled, on boundary buttons so they stay focusable", () => {
    const onPageChange = vi.fn();
    renderGrid({ total: 57, page: 1, onPageChange });

    const first = screen.getByTestId("grid-page-first");
    expect(first).toHaveAttribute("aria-disabled", "true");
    expect(first).not.toBeDisabled();
    fireEvent.click(first);
    expect(onPageChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("grid-page-next"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("disables the forward controls on the last page", () => {
    const onPageChange = vi.fn();
    renderGrid({ total: 57, page: 3, onPageChange });
    expect(screen.getByTestId("grid-page-next")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByTestId("grid-page-next"));
    expect(onPageChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("grid-page-prev"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// Toolbar + selection
// ---------------------------------------------------------------------------
describe("DataGrid toolbar", () => {
  it("opens an opt-in search popover with the current query", async () => {
    renderGrid({
      searchDisplay: "popover",
      search: { value: "billing", onChange: vi.fn(), label: "Search feedback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search feedback" }));
    expect(await screen.findByDisplayValue("billing")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("debounces the text filter", async () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      renderGrid({
        search: { value: "", onChange, debounceMs: 200, label: "Search feedback" },
      });
      const input = screen.getByTestId("grid-search");
      fireEvent.change(input, { target: { value: "d" } });
      fireEvent.change(input, { target: { value: "da" } });
      fireEvent.change(input, { target: { value: "dark" } });
      expect(onChange).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("dark");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders faceted filters and toolbar actions", () => {
    renderGrid({
      filters: [
        {
          id: "status",
          label: "Status",
          value: "OPEN",
          options: [{ value: "OPEN", label: "Open" }],
          onValueChange: vi.fn(),
        },
      ],
      toolbarActions: <button type="button">New feedback</button>,
    });
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New feedback" })).toBeInTheDocument();
  });
});

describe("DataGrid selection (opt-in)", () => {
  it("renders no selection column when no selection prop is passed", () => {
    renderGrid();
    expect(screen.queryByTestId("grid-cell-__select")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("renders checkboxes and reports the selected ids when opted in", () => {
    const onChange = vi.fn();
    renderGrid({
      selection: {
        selectedIds: ["r2"],
        onChange,
        rowLabel: (row: Row) => `Select ${row.title}`,
      },
    });

    expect(screen.getAllByTestId("grid-cell-__select")).toHaveLength(2);
    const rows = screen.getAllByTestId("grid-row");
    expect(rows[1]).toHaveAttribute("data-state", "selected");
    expect(rows[0]).not.toHaveAttribute("data-state");

    fireEvent.click(screen.getByLabelText("Select Dark mode"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(new Set(onChange.mock.calls[0][0])).toEqual(new Set(["r1", "r2"]));
  });
});

// ---------------------------------------------------------------------------
// Scroll viewport, sticky header and height modes
// ---------------------------------------------------------------------------
function container(view: ReturnType<typeof renderGrid>) {
  const node = view.container.querySelector('[data-slot="table-container"]');
  if (!node) throw new Error("table-container not found");
  return node as HTMLElement;
}

describe("DataGrid scroll viewport", () => {
  // Regression class this guards: a grid that renders inside a clipping
  // ancestor and owns no scroll viewport of its own silently hides every row
  // past the fold. PR #219 patched that per page with an outer
  // `overflow-y-auto` wrapper — which cannot work with a sticky header,
  // because `overflow-x: auto` already makes `table-container` the nearest
  // scrolling ancestor and a sticky `<th>` therefore resolves against THAT
  // box, not the outer wrapper. The viewport has to be the container itself.
  it("puts the vertical scroll on table-container, not on an outer wrapper", () => {
    const view = renderGrid({ height: "fill" });
    const node = container(view);

    expect(node.className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/);
    expect(node.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(node.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
    // The horizontal behaviour the `table-fixed` layout depends on survives
    // verbatim rather than via class-merge order.
    expect(node.className).toMatch(/(?:^|\s)overflow-x-auto(?:\s|$)/);
    expect(node.className).not.toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
  });

  it("claims the parent's height only in fill mode", () => {
    const fill = renderGrid({ height: "fill" });
    expect(screen.getByTestId("data-grid").className).toMatch(
      /(?:^|\s)flex-1(?:\s|$)/,
    );
    expect(screen.getByTestId("data-grid")).toHaveAttribute(
      "data-height",
      "fill",
    );
    fill.unmount();

    // The default. A `flex-1 min-h-0` grid dropped into an unbounded parent
    // collapses to zero height, so `natural` has to be what you get for free.
    const natural = renderGrid();
    const root = screen.getByTestId("data-grid");
    expect(root).toHaveAttribute("data-height", "natural");
    expect(root.className).not.toMatch(/(?:^|\s)flex-1(?:\s|$)/);
    expect(root.className).not.toMatch(/(?:^|\s)min-h-0(?:\s|$)/);
    expect(container(natural).className).not.toMatch(
      /(?:^|\s)overflow-y-auto(?:\s|$)/,
    );
  });

  it("bounds a natural grid with maxHeight so its header has something to stick to", () => {
    const view = renderGrid({ height: "natural", maxHeight: "20rem" });

    expect(screen.getByTestId("data-grid")).toHaveStyle({
      "--data-grid-max-h": "20rem",
    });
    expect(container(view).className).toMatch(/max-h-\(--data-grid-max-h\)/);
    expect(container(view).className).toMatch(
      /(?:^|\s)overflow-y-auto(?:\s|$)/,
    );
  });

  it("sticks every header cell to the top of the viewport with an opaque background", () => {
    renderGrid({
      height: "fill",
      selection: { selectedIds: [], onChange: vi.fn() },
    });

    const heads = screen.getAllByRole("columnheader");
    expect(heads.length).toBeGreaterThan(1);
    for (const head of heads) {
      expect(head.className).toMatch(/(?:^|\s)sticky(?:\s|$)/);
      expect(head.className).toMatch(/(?:^|\s)top-0(?:\s|$)/);
      // Without an opaque cell background, body rows scroll through the
      // header: under `border-collapse: collapse` a <tr>/<thead> background
      // does not reliably paint behind a sticky cell.
      expect(head.className).toMatch(/(?:^|\s)bg-surface-panel(?:\s|$)/);
      // The underline must be an inset shadow. A collapsed `border-b` belongs
      // to the table grid rather than the cell and scrolls away on its own.
      expect(head.className).toMatch(/shadow-\[inset_0_-1px_0_/);
    }
  });
});

describe("DataGrid chrome opt-outs", () => {
  it("hides the pagination footer when pagination is false", () => {
    renderGrid({ pagination: false });
    expect(screen.queryByTestId("grid-pagination")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
    // Rows still render — the opt-out is chrome-only.
    expect(screen.getAllByTestId("grid-row")).toHaveLength(2);
  });

  it("hides the toolbar and its Columns menu when toolbar is false", () => {
    renderGrid({ toolbar: false });
    expect(
      screen.queryByRole("button", { name: /Columns/i }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
  });

  it("does not install a body-wide MutationObserver for a toolbar that will never render", () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    renderGrid({ toolbar: false, toolbarPortalId: "nonexistent-host" });
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });

  it("derives page math from rows.length when total/page/pageSize are omitted", () => {
    renderGrid({ total: undefined, page: undefined, pageSize: undefined });
    expect(screen.getByTestId("grid-pagination-summary")).toHaveTextContent(
      "1–2 of 2 results",
    );
    expect(screen.getByTestId("grid-page-indicator")).toHaveTextContent(
      "Page 1 of 1",
    );
  });

  it("survives an empty unpaginated page without a zero pageSize", () => {
    renderGrid({
      rows: [],
      total: undefined,
      page: undefined,
      pageSize: undefined,
    });
    expect(screen.getByTestId("grid-empty-row")).toBeInTheDocument();
    expect(screen.getByTestId("grid-page-indicator")).toHaveTextContent(
      "Page 1 of 1",
    );
  });
});

describe("DataGrid rowClassName", () => {
  it("applies caller classes per row without losing the grid's own row hooks", () => {
    renderGrid({
      rowClassName: (row: Row) =>
        row.id === "r2" ? "bg-surface-inset/50" : undefined,
    });

    const rows = screen.getAllByTestId("grid-row");
    expect(rows[0].className).not.toMatch(/bg-surface-inset/);
    expect(rows[1].className).toMatch(/bg-surface-inset\/50/);
    expect(rows[1]).toHaveAttribute("data-row-id", "r2");
  });
});
