import type { ReactNode } from "react";
import {
  columnOrderingFeature,
  columnVisibilityFeature,
  metaHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  type ColumnDef,
  type Table,
} from "@tanstack/react-table";

/**
 * Shared types for the Compass DataGrid.
 *
 * TanStack Table v9 notes that matter here (verified against the installed
 * 9.1.2, not docs):
 *  - features come from an explicit `tableFeatures({...})` registry;
 *  - row models are *feature slots*, and in all-manual mode we register **none**
 *    of them, because sorting, filtering and pagination all happen in Postgres;
 *  - `ColumnDef` is `ColumnDef<TFeatures, TData, TValue>`;
 *  - Compass metadata rides on the per-table `columnMeta` slot rather than a
 *    global `declare module` augmentation, which would leak into every table in
 *    the app.
 */

/**
 * The row-shape constraint. Mirrors table-core's own `RowData`, which is not
 * re-exported by `@tanstack/react-table` and cannot be imported from
 * `@tanstack/table-core` (not a direct dependency under pnpm). `Record<string,
 * any>` rather than `Record<string, unknown>` on purpose: the latter rejects
 * plain `interface` row types, which have no index signature.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GridRowData = Record<string, any>;

/** Every server action driven by the grid returns this discriminated result. */
export type GridActionResult = { ok: true } | { ok: false; error: string };

export type GridSortDirection = "asc" | "desc";

/** The active sort, expressed in the caller's URL vocabulary. */
export type GridSort = { key: string; dir: GridSortDirection } | null;

export type GridAlign = "start" | "end";

/** One choice in an inline-edit picker. */
export type GridEditOption = {
  value: string;
  label: string;
  icon?: ReactNode;
};

/**
 * Inline edit config for a column.
 *
 * `field` is the property the optimistic overlay writes on the row, so the
 * merged row reflects the edit before the server confirms it.
 */
export type GridEdit<TRow extends GridRowData> = {
  kind: "select";
  options: readonly GridEditOption[];
  /** Current value for a row. */
  getValue: (row: TRow) => string;
  /** Row property the optimistic value is written to. */
  field: keyof TRow & string;
  /** Persist the change. Must resolve, never reject, with a result object. */
  save: (row: TRow, next: string) => Promise<GridActionResult>;
  /** Accessible name for the trigger, e.g. `(row) => \`Status for ${row.title}\``. */
  triggerLabel?: (row: TRow) => string;
  /** Custom trigger content; defaults to the option's label. */
  renderTrigger?: (option: GridEditOption | undefined, row: TRow) => ReactNode;
  /** Disable editing for particular rows. */
  isDisabled?: (row: TRow) => boolean;
};

/** Compass metadata attached to a column definition. */
export type GridColumnMeta<TRow extends GridRowData> = {
  /** Human label used by the column menu and the live region. Falls back to the id. */
  label?: string;
  /**
   * URL sort key. Presence makes the header sortable. Defaults to the column
   * id when `sortable` is true.
   */
  sortKey?: string;
  sortable?: boolean;
  /** `false` means the column can be neither hidden nor reordered. */
  hideable?: boolean;
  /** Fixed `<col>` width, e.g. `"8rem"`. Identical across SSR and hydrated frames. */
  width?: string;
  align?: GridAlign;
  /**
   * How a cell handles content wider than its column.
   *
   *  - `"clip"` (default) — the cell clips at its own padding box and
   *    ellipsizes. Required because the grid renders `table-fixed` and the
   *    shared TableCell is `whitespace-nowrap`: a declared width is a hard box
   *    and unwrappable content that nothing clips escapes it and paints over
   *    the next column.
   *  - `"visible"` — opt out, for a cell that must paint outside its box.
   *    Overlay UI does *not* need this: Select, DropdownMenu and Tooltip all
   *    render through a portal on `document.body`, so they are not descendants
   *    of the cell and cannot be clipped by it.
   */
  overflow?: "clip" | "visible";
  headerClassName?: string;
  cellClassName?: string;
  /** Inline editing for this column. */
  edit?: GridEdit<TRow>;
};

/**
 * The feature registry. Only the features the grid actually uses are
 * registered: filtering is URL-driven and rendered by the toolbar, so
 * `columnFilteringFeature` would be dead state.
 *
 * `metaHelper` is a **type-only phantom** that is stripped at runtime, so every
 * `TRow` shares one runtime registry object. That keeps `features` referentially
 * stable across every grid in the app, which `useTable` requires.
 */
const GRID_FEATURES_RUNTIME = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  columnOrderingFeature,
  rowSelectionFeature,
  columnMeta: metaHelper<GridColumnMeta<never>>(),
});

export type GridFeatures<TRow extends GridRowData> = ReturnType<typeof tableFeatures<{
  rowSortingFeature: typeof rowSortingFeature;
  rowPaginationFeature: typeof rowPaginationFeature;
  columnVisibilityFeature: typeof columnVisibilityFeature;
  columnOrderingFeature: typeof columnOrderingFeature;
  rowSelectionFeature: typeof rowSelectionFeature;
  columnMeta: ReturnType<typeof metaHelper<GridColumnMeta<TRow>>>;
}>>;

/** The single, stable feature registry, typed for a given row shape. */
export function gridFeatures<TRow extends GridRowData>(): GridFeatures<TRow> {
  return GRID_FEATURES_RUNTIME as unknown as GridFeatures<TRow>;
}

/** A Compass grid column definition. */
export type GridColumnDef<TRow extends GridRowData> = ColumnDef<GridFeatures<TRow>, TRow, unknown>;

/** The `useTable` instance type for a given row shape. */
export type GridTable<TRow extends GridRowData> = Table<GridFeatures<TRow>, TRow>;

/** Per-row state the mobile renderer and cell renderers can read. */
export type GridRowState<TRow extends GridRowData> = {
  row: TRow;
  id: string;
  /** A write for this row is in flight. */
  pending: boolean;
  /**
   * The row's settled optimistic value no longer matches the active filters,
   * so it is showing stale relative to the server-side query.
   */
  stale: boolean;
  /** Inline error from the last failed write on this row. */
  error?: string;
  selected: boolean;
};

/** Opt-in row selection. If a consumer never passes this, the path stays dark. */
export type GridSelection<TRow extends GridRowData> = {
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  /** Accessible name for a row's checkbox. */
  rowLabel?: (row: TRow) => string;
};

/** Debounced free-text filter in the toolbar. */
export type GridSearch = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Accessible label. Defaults to "Search". */
  label?: string;
  debounceMs?: number;
};
