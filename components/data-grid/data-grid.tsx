"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useTable } from "@tanstack/react-table";
import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FacetedFilterGroup } from "@/components/patterns/faceted-filter-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import {
  DataGridHeaderCell,
  STICKY_HEADER_CELL_CLASS,
} from "./data-grid-header-cell";
import { DataGridPagination } from "./data-grid-pagination";
import { DataGridToolbar } from "./data-grid-toolbar";
import { DraftArea } from "./draft-area";
import { CellDisplay } from "./cells/cell-display";
import { CellEditor } from "./cells/cell-editor";
import { formatCellValue, parseCellText } from "./cells/cell-values";
import { formatTsv, parseTsv, rangeToMatrix } from "./clipboard";
import { EditableCell } from "./editable-cell";
import {
  DEFAULT_RANGE_OP_LIMIT,
  createChangeSet,
  describePlan,
  planClear,
  planFill,
  planPaste,
  runGrouped,
  type GridChangeSet,
  type GridChangeSource,
  type PlanGrid,
  type PlannedChange,
  type RangePlan,
} from "./interaction/range-ops";
import {
  isSingleCell,
  moveCorner,
  rangeContains,
  selectionRange,
  type GridRange,
} from "./interaction/range";
import {
  nextPosition,
  resolveGridKey,
  type GridDimensions,
  type GridPosition,
} from "./interaction/grid-keymap";
import {
  resolveActiveCell,
  resolveRangeEnd,
  useGridInteraction,
} from "./interaction/use-grid-interaction";
import { useGridPreferences } from "./use-grid-preferences";
import {
  gridFeatures,
  type GridActionResult,
  type GridCellValue,
  type GridColumnDef,
  type GridColumnMeta,
  type GridCreation,
  type GridCreationMode,
  type GridCreationRequest,
  type GridEdit,
  type GridRowData,
  type GridRowState,
  type GridSearch,
  type GridSelection,
  type GridSort,
} from "./types";

/** Synthetic id of the injected selection column. */
export const SELECTION_COLUMN_ID = "__select";

/**
 * The grid's default cell-overflow guard, opted out of per column with
 * `meta.overflow: "visible"`.
 *
 * `table-fixed` and `whitespace-nowrap` are the *grid's* choices, so containing
 * their consequence is the grid's job rather than every column author's: a
 * declared width is a hard box, content cannot wrap out of it, and anything
 * wider that nothing clips escapes and paints over the next column. Requiring
 * each column to remember `truncate` made that a latent bug in every column
 * that forgot and in every column added later.
 *
 * It lands on the `<td>` rather than on an inner wrapper on purpose. Overflow
 * clips to the padding box, and the cell already carries `p-2`, so 8px of slack
 * sits between the clip edge and any content — enough for the `ring-3` focus
 * rings used throughout, which a zero-padding inner wrapper would cut off.
 * A `<td>` is a block container, so `text-overflow` applies to its own line
 * boxes and inline cell content ellipsizes without any inner element at all.
 *
 * Not added to `components/ui/table.tsx`'s TableCell: that primitive is shared
 * with auto-layout tables, where a wide cell widens its column instead of
 * overlapping the next one and clipping would only lose content.
 */
const CELL_CLIP_CLASS = "overflow-hidden text-ellipsis";

/**
 * Floor for a flexible column (one with no `meta.width`) that declares no
 * `meta.minWidth` of its own.
 *
 * Every column is reserved *something* in the table's `min-width` so a column
 * added later cannot silently reintroduce the zero-width collapse that
 * reservation exists to prevent.
 */
export const DEFAULT_MIN_WIDTH = "8rem";

export type DataGridProps<TRow extends GridRowData> = {
  /** Namespace for persisted column preferences: `compass:grid:{gridId}:v1`. */
  gridId: string;
  columns: readonly GridColumnDef<TRow>[];
  /** The current server page. Sorting/filtering/paging all happened in SQL. */
  rows: readonly TRow[];
  getRowId: (row: TRow) => string;

  /**
   * Server-reported total across all pages. Defaults to `rows.length`, which is
   * the correct value for an unpaginated grid (`pagination={false}`).
   */
  total?: number;
  /** 1-based. Defaults to 1. */
  page?: number;
  /** Defaults to `rows.length` (floored at 1, so an empty page is still valid). */
  pageSize?: number;
  pageSizes?: readonly number[];
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;

  /** Active sort, in the caller's URL vocabulary. */
  sort?: GridSort;
  /** Called with a column's sort key. The caller owns the direction. */
  onSortChange?: (sortKey: string) => void;

  /** Screen-reader description of the table. Rendered as an sr-only caption. */
  caption: string;

  search?: GridSearch;
  /** Optional screen-specific control rendered before search in the toolbar. */
  toolbarLeading?: React.ReactNode;
  /** Moves the toolbar into an existing shell slot while the grid retains its state. */
  toolbarPortalId?: string;
  searchDisplay?: "inline" | "popover";
  filters?: readonly FacetedFilterGroup[];
  onClearFilters?: () => void;
  toolbarActions?: React.ReactNode;

  /**
   * Below `md`, each row renders as a stacked card inside a single full-width
   * `<td colSpan>`, so the DOM stays a real table (test ids and table semantics
   * survive) while the visual stays card-like. Without this the grid falls back
   * to the normal column layout at every width.
   */
  renderMobileRow?: (row: TRow, state: GridRowState<TRow>) => React.ReactNode;

  /**
   * Whether a row still matches the *server-side* filters. Used to mark a row
   * stale after an inline edit takes it out of the active query.
   */
  rowMatchesFilters?: (row: TRow) => boolean;
  /** Invoked by the "Refresh" action on the stale strip. */
  onRefresh?: () => void;

  /** Opt-in. If this is never passed, the selection code path stays dark. */
  selection?: GridSelection<TRow>;

  /**
   * Opt-in spreadsheet behaviour: `role="grid"`, a roving tabindex (the grid is
   * one tab stop), arrow / Tab / Enter / Esc / F2 navigation, type-to-edit, and
   * typed editors for every `edit.kind`. Enter edits the active cell and
   * Alt+Enter calls `onOpenRow`. Absent, the grid behaves exactly as before.
   * Ignored below `md` when `renderMobileRow` is in use.
   */
  interaction?: "sheet";
  /** Called by Alt+Enter on a cell in sheet mode, e.g. to open the detail panel. */
  onOpenRow?: (row: TRow) => void;
  /**
   * Render every editable column non-editable. Pass the workspace context's
   * `isReadOnly`. A UX affordance only: the server still enforces writes.
   */
  readOnly?: boolean;
  /**
   * Most cells one paste, fill or clear may write in sheet mode. A larger
   * operation is refused with a message instead of writing a prefix.
   * Defaults to 200.
   */
  rangeLimit?: number;
  /**
   * Called once per multi-cell gesture (paste, fill, clear, cut) after every
   * cell has settled. One gesture is one change set, the unit undo will replay.
   */
  onChangeSet?: (changeSet: GridChangeSet) => void;

  /**
   * Opt-in draft area under the rows for creating rows in bulk: type or paste N
   * rows, then submit once. Drafts live in the area's own state (not the
   * optimistic overlay), so a server re-delivery of `rows` never clears them.
   * Hidden below `md` and when `readOnly`.
   */
  creation?: GridCreation;
  /**
   * Several ways of adding rows with a switch between them (Discovery: "Add
   * opportunities" / "Add solutions"). Takes the place of `creation`; the first
   * mode is the default. Pass a stable reference.
   */
  creationModes?: readonly GridCreationMode[];
  /** Switches `creationModes` to a mode and preselects its parent, e.g. from a row action. */
  creationRequest?: GridCreationRequest;

  /**
   * How the grid claims vertical space.
   *
   *  - `"fill"`    — the grid IS the scroll viewport and consumes the height its
   *                  parent gives it. For a full-page view inside
   *                  `WorkspacePage`'s `md:overflow-hidden` content area, where
   *                  nothing else will ever scroll.
   *  - `"natural"` — the grid grows to fit its content, optionally capped by
   *                  `maxHeight`, and the page scrolls around it. For small
   *                  in-page tables (settings panels, detail-panel sub-lists).
   *
   * A two-value union rather than a boolean: `fill={false}` reads as "don't
   * fill" rather than "grow naturally", and the two failure modes are
   * different. Defaults to `"natural"`, the only safe value for an unknown
   * container — `"fill"` in an unbounded parent collapses to zero height.
   */
  height?: "fill" | "natural";
  /**
   * Caps the scroll viewport. Only meaningful with `height="natural"`; a CSS
   * length such as `"20rem"`. Without it a natural grid has no bounded height,
   * so its header has nothing to stick to.
   */
  maxHeight?: string;

  /** `false` hides the pagination footer entirely. Default `true`. */
  pagination?: boolean;
  /**
   * `false` hides the toolbar — search, filters and the Columns menu — and
   * skips installing the portal-host observer. Default `true`.
   */
  toolbar?: boolean;

  /** Extra classes for a body `<tr>`. Receives the merged row and its state. */
  rowClassName?: (row: TRow, state: GridRowState<TRow>) => string | undefined;

  emptyState?: React.ReactNode;
  className?: string;
};

/**
 * An optimistic edit is a function over the server row rather than a partial,
 * so a nested row shape (Discovery's `{ kind, opportunity }`) can express its
 * own merge via `applyOptimistic`. Edits to one row compose in order.
 */
type OverrideEdit<TRow> = { seq: number; apply: (row: TRow) => TRow; pending: boolean };
/**
 * A row's optimistic edits in the order they were made. Kept as a list (not one
 * composed function) so a failed save rolls back ONLY its own edit: a paste that
 * writes three cells of a row must not undo the two that saved.
 */
type OverrideEntry<TRow> = readonly OverrideEdit<TRow>[];

const applyEntry = <TRow,>(entry: OverrideEntry<TRow>, row: TRow): TRow =>
  entry.reduce((current, edit) => edit.apply(current), row);
const entryPending = <TRow,>(entry: OverrideEntry<TRow>): boolean =>
  entry.some((edit) => edit.pending);

/** Rows shown per PageUp / PageDown in sheet mode. */
const SHEET_PAGE_ROWS = 10;

function metaOf<TRow extends GridRowData>(
  column: GridColumnDef<TRow>,
): GridColumnMeta<TRow> {
  return (column.meta ?? {}) as GridColumnMeta<TRow>;
}

function labelOf<TRow extends GridRowData>(
  column: GridColumnDef<TRow>,
): string {
  const meta = metaOf(column);
  if (meta.label) return meta.label;
  if (typeof column.header === "string") return column.header;
  return column.id ?? "";
}

export function DataGrid<TRow extends GridRowData>({
  gridId,
  columns,
  rows,
  getRowId,
  total: totalProp,
  page = 1,
  pageSize: pageSizeProp,
  pageSizes,
  onPageChange,
  onPageSizeChange,
  sort = null,
  onSortChange,
  caption,
  search,
  toolbarLeading,
  toolbarPortalId,
  searchDisplay,
  filters,
  onClearFilters,
  toolbarActions,
  renderMobileRow,
  rowMatchesFilters,
  onRefresh,
  selection,
  interaction,
  onOpenRow,
  readOnly = false,
  rangeLimit = DEFAULT_RANGE_OP_LIMIT,
  onChangeSet,
  creation,
  creationModes,
  creationRequest,
  height = "natural",
  maxHeight,
  pagination = true,
  toolbar = true,
  rowClassName,
  emptyState,
  className,
}: DataGridProps<TRow>) {
  const isMobile = useIsMobile();
  const drafting = React.useMemo<readonly GridCreationMode[] | undefined>(
    () =>
      creationModes && creationModes.length > 0
        ? creationModes
        : creation
          ? [{ id: "default", label: "", creation }]
          : undefined,
    [creation, creationModes],
  );
  const mobileMode = isMobile && Boolean(renderMobileRow);

  // An unpaginated grid still needs coherent page math for the live region and
  // the (hidden) footer. Defaulting here rather than at five call sites also
  // contains the degenerate `rows.length === 0` case in one place.
  const total = totalProp ?? rows.length;
  const pageSize = pageSizeProp ?? Math.max(1, rows.length);

  const subscribeToToolbarHost = React.useCallback(
    (onStoreChange: () => void) => {
      // Without the `toolbar` guard this observes every DOM mutation in the app
      // on behalf of a toolbar that will never render.
      if (!toolbar || !toolbarPortalId) return () => {};
      const observer = new MutationObserver(onStoreChange);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
    [toolbar, toolbarPortalId],
  );
  const getToolbarHost = React.useCallback(
    () => (toolbarPortalId ? document.getElementById(toolbarPortalId) : null),
    [toolbarPortalId],
  );
  const toolbarPortal = React.useSyncExternalStore(
    subscribeToToolbarHost,
    getToolbarHost,
    () => null,
  );

  // ── Optimistic overlay ────────────────────────────────────────────────────
  // A server-truth overlay, not `useOptimistic`: `useOptimistic` resets when its
  // transition settles and cannot hold a value across a non-refreshing
  // interaction, which the stale-row UX below requires.
  const [overrides, setOverrides] = React.useState<
    Map<string, OverrideEntry<TRow>>
  >(new Map());
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());

  // Reset DURING RENDER (React's documented "adjust state when a prop changes"
  // pattern) rather than in an effect: an effect commits a stale frame first,
  // which is a visible revert flash.
  //
  // Overrides with an in-flight write are PRESERVED. `revalidatePath` inside a
  // still-pending server action re-delivers an RSC payload that predates the
  // write; without this exclusion that payload permanently wipes the edit.
  const [previousRows, setPreviousRows] = React.useState(rows);
  if (previousRows !== rows) {
    setPreviousRows(rows);
    setOverrides((previous) => {
      if (previous.size === 0) return previous;
      const kept = new Map<string, OverrideEntry<TRow>>();
      let changed = false;
      for (const [id, entry] of previous) {
        const inFlight = entry.filter((edit) => edit.pending);
        if (inFlight.length !== entry.length) changed = true;
        if (inFlight.length > 0) kept.set(id, inFlight);
      }
      return changed ? kept : previous;
    });
    setErrors((previous) => (previous.size === 0 ? previous : new Map()));
  }

  const mergedRows = React.useMemo(
    () =>
      rows.map((row) => {
        const entry = overrides.get(getRowId(row));
        return entry ? applyEntry(entry, row) : row;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getRowId is a caller-stable accessor
    [rows, overrides],
  );

  const rowStates = React.useMemo(() => {
    const selected = new Set(selection?.selectedIds ?? []);
    const map = new Map<string, GridRowState<TRow>>();
    for (const row of mergedRows) {
      const id = getRowId(row);
      const entry = overrides.get(id);
      map.set(id, {
        row,
        id,
        pending: entry ? entryPending(entry) : false,
        // Derived, never stored: it self-clears when the override clears, so
        // "server wins" needs no separate stale-reset path. A row is
        // deliberately NOT stale while pending, since the write may still fail.
        stale:
          Boolean(entry) &&
          !(entry && entryPending(entry)) &&
          Boolean(rowMatchesFilters) &&
          !rowMatchesFilters?.(row),
        error: errors.get(id),
        selected: selected.has(id),
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getRowId is a caller-stable accessor
  }, [mergedRows, overrides, errors, rowMatchesFilters, selection?.selectedIds]);

  const editSeq = React.useRef(0);

  /** Shows `next` immediately and returns the handle used to settle it. */
  const applyOptimisticEdit = React.useCallback(
    (id: string, edit: GridEdit<TRow>, next: GridCellValue): number => {
      // The union's members differ only in value type; the cell that produced
      // `next` already parsed it for its own kind.
      const applyOptimistic = edit.applyOptimistic as
        | ((row: TRow, next: GridCellValue) => TRow)
        | undefined;
      const apply = (current: TRow): TRow =>
        applyOptimistic
          ? applyOptimistic(current, next)
          : ({ ...current, [edit.field]: next } as TRow);
      editSeq.current += 1;
      const seq = editSeq.current;
      setOverrides((previous) =>
        new Map(previous).set(id, [
          ...(previous.get(id) ?? []),
          { seq, apply, pending: true },
        ]),
      );
      return seq;
    },
    [],
  );

  const settleEdit = React.useCallback((id: string, seq: number, saved: boolean) => {
    setOverrides((previous) => {
      const entry = previous.get(id);
      if (!entry) return previous;
      const map = new Map(previous);
      // A failure rolls back only this edit; the rest of the row stands.
      const next = saved
        ? entry.map((edit) => (edit.seq === seq ? { ...edit, pending: false } : edit))
        : entry.filter((edit) => edit.seq !== seq);
      if (next.length === 0) map.delete(id);
      else map.set(id, next);
      return map;
    });
  }, []);

  const persistEdit = React.useCallback(
    async (
      id: string,
      row: TRow,
      edit: GridEdit<TRow>,
      next: GridCellValue,
      seq: number,
    ): Promise<GridActionResult> => {
      const save = edit.save as (
        row: TRow,
        next: GridCellValue,
      ) => Promise<GridActionResult>;
      let result: GridActionResult;
      try {
        result = await save(row, next);
      } catch {
        // `save` is contracted never to reject; a rejection must still roll back.
        result = { ok: false, error: "Couldn't save that change. Try again." };
      }
      settleEdit(id, seq, result.ok);
      return result;
    },
    [settleEdit],
  );

  const clearRowErrors = React.useCallback((ids: readonly string[]) => {
    setErrors((previous) => {
      if (!ids.some((id) => previous.has(id))) return previous;
      const map = new Map(previous);
      for (const id of ids) map.delete(id);
      return map;
    });
  }, []);

  const commitEdit = React.useCallback(
    async (id: string, row: TRow, edit: GridEdit<TRow>, next: GridCellValue) => {
      clearRowErrors([id]);
      // Apply optimistically, synchronously, before awaiting anything.
      const seq = applyOptimisticEdit(id, edit, next);
      const result = await persistEdit(id, row, edit, next, seq);
      if (!result.ok) {
        // There is no toast library in this repo and one is not being added.
        setErrors((previous) => new Map(previous).set(id, result.error));
      }
    },
    [applyOptimisticEdit, clearRowErrors, persistEdit],
  );

  // ── Columns ───────────────────────────────────────────────────────────────
  const selectionColumn = React.useMemo<GridColumnDef<TRow> | null>(() => {
    if (!selection) return null;
    return {
      id: SELECTION_COLUMN_ID,
      header: "",
      meta: { label: "Select", hideable: false, width: "2.5rem" },
      cell: () => null,
    } satisfies GridColumnDef<TRow>;
  }, [selection]);

  const allColumns = React.useMemo(
    () => (selectionColumn ? [selectionColumn, ...columns] : [...columns]),
    [columns, selectionColumn],
  );

  const preferenceColumns = React.useMemo(
    () =>
      allColumns.map((column) => ({
        id: column.id as string,
        hideable: metaOf(column).hideable !== false,
      })),
    [allColumns],
  );

  const preferences = useGridPreferences(gridId, preferenceColumns);

  // ── Table instance ────────────────────────────────────────────────────────
  const features = gridFeatures<TRow>();

  const sortedColumnId = React.useMemo(() => {
    if (!sort) return null;
    const match = allColumns.find((column) => {
      const meta = metaOf(column);
      return (meta.sortKey ?? column.id) === sort.key;
    });
    return (match?.id as string | undefined) ?? null;
  }, [allColumns, sort]);

  const sortingState = React.useMemo(
    () =>
      sortedColumnId && sort
        ? [{ id: sortedColumnId, desc: sort.dir === "desc" }]
        : [],
    [sortedColumnId, sort],
  );

  const paginationState = React.useMemo(
    () => ({ pageIndex: Math.max(0, page - 1), pageSize }),
    [page, pageSize],
  );

  // v9's RowSelectionState is `Record<string, true>` — an unselected row is
  // absent from the map rather than present with `false`.
  const rowSelectionState = React.useMemo(() => {
    const map: Record<string, true> = {};
    for (const id of selection?.selectedIds ?? []) map[id] = true;
    return map;
  }, [selection?.selectedIds]);

  const table = useTable({
    features,
    columns: allColumns,
    data: mergedRows,
    getRowId,
    // Every engine is server-owned: Postgres does the sorting, filtering and
    // paging, and `rowCount` is the server total rather than `data.length`.
    manualSorting: true,
    manualPagination: true,
    rowCount: total,
    enableRowSelection: Boolean(selection),
    state: {
      sorting: sortingState,
      pagination: paginationState,
      columnVisibility: preferences.columnVisibility,
      columnOrder: preferences.columnOrder,
      rowSelection: rowSelectionState,
    },
    onSortingChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(sortingState) : updater;
      const first = next[0];
      if (!first) return;
      const column = allColumns.find((candidate) => candidate.id === first.id);
      onSortChange?.(metaOf(column ?? ({} as GridColumnDef<TRow>)).sortKey ?? first.id);
    },
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(paginationState) : updater;
      if (next.pageSize !== paginationState.pageSize) {
        onPageSizeChange?.(next.pageSize);
        return;
      }
      if (next.pageIndex !== paginationState.pageIndex) {
        onPageChange?.(next.pageIndex + 1);
      }
    },
    onColumnVisibilityChange: () => {
      // Visibility is owned by useGridPreferences and driven from the column
      // menu; the table never initiates a change of its own.
    },
    onColumnOrderChange: () => {
      // Order is owned by useGridPreferences; see onColumnVisibilityChange.
    },
    onRowSelectionChange: (updater) => {
      if (!selection) return;
      const next =
        typeof updater === "function" ? updater(rowSelectionState) : updater;
      selection.onChange(
        Object.entries(next)
          .filter(([, value]) => value)
          .map(([id]) => id),
      );
    },
  });

  const visibleColumns = React.useMemo(() => {
    const byId = new Map(allColumns.map((column) => [column.id as string, column]));
    return preferences.columnOrder
      .map((id) => byId.get(id))
      .filter((column): column is GridColumnDef<TRow> => Boolean(column))
      .filter((column) => preferences.columnVisibility[column.id as string] !== false);
  }, [allColumns, preferences.columnOrder, preferences.columnVisibility]);

  // In mobile mode every row is a single full-width `<td colSpan>` card, so the
  // table genuinely has ONE column. Keeping the desktop column count here would
  // also keep the desktop `<colgroup>`, whose fixed widths sum to more than a
  // phone viewport (measured: a 704px table inside a 358px container at
  // 390x844) and reintroduce exactly the horizontal scroll the stacked-card
  // layout exists to avoid.
  const columnCount = mobileMode ? 1 : visibleColumns.length;

  /*
    Why the table needs an explicit `min-width` at all.

    `components/ui/table.tsx` renders the table element as `w-full`, and this
    grid adds `table-fixed`. Under `table-layout: fixed` it NEVER overflows its
    container on its own: when the `<colgroup>` widths sum to more than the
    available width, browsers scale every column down proportionally, and a
    column with no declared width gets `container − Σ(declared)` — which goes
    NEGATIVE once the fixed columns out-sum the container, clamping the column
    to zero. So the flexible first column (Tasks "Title", Discovery "Item")
    silently collapsed to invisible at phone widths while the fixed columns
    were crushed, and the `overflow-x-auto` wrapper never had anything to
    scroll. Reported against this PR's preview at 390px.

    Reserving the sum here is what converts that shortfall into real horizontal
    scrolling: `width: 100%` still wins whenever the container is wider, and
    below the sum the table simply stops shrinking and overflows the wrapper.

    Flexible columns are reserved as `count × max(floor)`, not `Σ(floor)`,
    because fixed layout splits the leftover space EQUALLY among the columns
    that declared no width. Reserving only the sum would let a grid with two
    unequal floors hand the smaller-floored column an equal — and therefore
    too-small — share. For the single flexible column every current grid has,
    the two formulas are identical.
  */
  const tableMinWidth = React.useMemo(() => {
    if (mobileMode) return undefined;

    const fixed: string[] = [];
    const flexible: string[] = [];
    for (const column of visibleColumns) {
      const { width, minWidth } = metaOf(column);
      if (width) fixed.push(width);
      else flexible.push(minWidth ?? DEFAULT_MIN_WIDTH);
    }

    const parts = [...fixed];
    if (flexible.length > 0) {
      // `max()` and `calc()` keep this unit-agnostic: no parsing of "18rem",
      // and a column may declare its floor in any CSS length.
      parts.push(
        flexible.length === 1
          ? flexible[0]
          : `${flexible.length} * max(${flexible.join(", ")})`,
      );
    }
    if (parts.length === 0) return undefined;
    return `calc(${parts.join(" + ")})`;
  }, [mobileMode, visibleColumns]);

  // ── Column drag reorder ───────────────────────────────────────────────────
  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = React.useId();
  const sensors = useSensors(
    // A small distance threshold lets a plain click reach the sort button
    // inside the header instead of starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const order = preferences.columnOrder;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    preferences.setColumnOrder(arrayMove(order, from, to));
  }

  // ── Announcements ─────────────────────────────────────────────────────────
  const sortedColumn = allColumns.find((column) => column.id === sortedColumnId);
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const announcement = [
    sortedColumn && sort
      ? `Sorted by ${labelOf(sortedColumn)}, ${sort.dir === "asc" ? "ascending" : "descending"}.`
      : null,
    `${total} ${total === 1 ? "result" : "results"}.`,
    pageCount > 1 ? `Page ${page} of ${pageCount}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const [liveMessage, setLiveMessage] = React.useState("");
  const announced = React.useRef<string | null>(null);
  React.useEffect(() => {
    // Skip the very first value: announcing the initial state on load is noise.
    if (announced.current === null) {
      announced.current = announcement;
      return;
    }
    if (announced.current === announcement) return;
    announced.current = announcement;
    setLiveMessage(announcement);
  }, [announcement]);

  // ── Strips ────────────────────────────────────────────────────────────────
  const errorMessages = React.useMemo(
    () => Array.from(new Set(errors.values())),
    [errors],
  );
  const staleCount = React.useMemo(
    () => Array.from(rowStates.values()).filter((state) => state.stale).length,
    [rowStates],
  );

  const columnOptions = React.useMemo(
    () =>
      preferences.columnOrder
        .map((id) => allColumns.find((column) => column.id === id))
        .filter((column): column is GridColumnDef<TRow> => Boolean(column))
        .filter((column) => column.id !== SELECTION_COLUMN_ID)
        .map((column) => ({
          id: column.id as string,
          label: labelOf(column),
          visible: preferences.columnVisibility[column.id as string] !== false,
          hideable: metaOf(column).hideable !== false,
        })),
    [allColumns, preferences.columnOrder, preferences.columnVisibility],
  );

  const bodyRows = table.getRowModel().rows;

  // ── Sheet interaction ─────────────────────────────────────────────────────
  // Focus, edit mode and the draft text live in ONE reducer at the grid level,
  // never in column definitions: a definition that closed over them would change
  // identity on every keystroke and `FlexRender` would remount the whole column.
  const sheet = interaction === "sheet" && !mobileMode;
  const [sheetState, dispatchSheet] = useGridInteraction();
  const tbodyRef = React.useRef<HTMLTableSectionElement>(null);
  // Set the instant an edit is committed or cancelled, so the blur that follows
  // (or the listbox closing) cannot settle the same edit a second time.
  const editSettled = React.useRef(false);

  const navColumns = React.useMemo(
    () => visibleColumns.filter((column) => column.id !== SELECTION_COLUMN_ID),
    [visibleColumns],
  );
  const navColumnIds = React.useMemo(
    () => navColumns.map((column) => column.id as string),
    [navColumns],
  );
  const bodyRowIds = React.useMemo(
    () => bodyRows.map((tableRow) => tableRow.id),
    [bodyRows],
  );

  const rowAt = React.useCallback(
    (index: number): TRow | undefined => {
      const id = bodyRowIds[index];
      return id === undefined ? undefined : rowStates.get(id)?.row;
    },
    [bodyRowIds, rowStates],
  );

  /** The edit config that applies to a cell, or undefined when it is read-only. */
  const editableAt = React.useCallback(
    (rowIndex: number, colIndex: number): GridEdit<TRow> | undefined => {
      if (!sheet || readOnly) return undefined;
      const column = navColumns[colIndex];
      const edit = column ? metaOf(column).edit : undefined;
      const row = rowAt(rowIndex);
      if (!edit || !row || edit.isDisabled?.(row)) return undefined;
      return edit;
    },
    [sheet, readOnly, navColumns, rowAt],
  );

  const activePosition: GridPosition | null = React.useMemo(
    () =>
      sheet ? resolveActiveCell(sheetState, bodyRowIds, navColumnIds) : null,
    [sheet, sheetState, bodyRowIds, navColumnIds],
  );

  const editing =
    sheet &&
    sheetState.mode === "edit" &&
    activePosition !== null &&
    sheetState.active?.rowId === bodyRowIds[activePosition.row];

  const gridDimensions: GridDimensions = {
    rowCount: bodyRowIds.length,
    colCount: navColumnIds.length,
    isEditable: (r, c) => Boolean(editableAt(r, c)),
    pageSize: SHEET_PAGE_ROWS,
  };

  const focusCellAt = (position: GridPosition) => {
    const rowId = bodyRowIds[position.row];
    const columnId = navColumnIds[position.col];
    if (rowId === undefined || columnId === undefined) return;
    dispatchSheet({
      type: "focusCell",
      cell: { rowId, columnId },
      rowIndex: position.row,
    });
  };

  // ── Range ─────────────────────────────────────────────────────────────────
  // The active cell is the anchor; `rangeEnd` is the corner that moves. With no
  // moving corner the "range" is the active cell, so copy / paste / fill share
  // one path whether or not the user dragged.
  const rangeEndPosition = React.useMemo(
    () => (sheet ? resolveRangeEnd(sheetState, bodyRowIds, navColumnIds) : null),
    [sheet, sheetState, bodyRowIds, navColumnIds],
  );
  const rangeRect: GridRange | null = activePosition
    ? selectionRange(activePosition, rangeEndPosition)
    : null;
  const multiRange = rangeRect && !isSingleCell(rangeRect) ? rangeRect : null;
  const fillPreview =
    rangeRect && sheetState.fillTo !== null && sheetState.fillTo > rangeRect.bottom
      ? { from: rangeRect.bottom + 1, to: sheetState.fillTo }
      : null;

  /** A non-blocking note about the last range operation (clamped, skipped, refused). */
  const [rangeNotice, setRangeNotice] = React.useState<string | null>(null);

  /** Text of a cell as copied: the column's `format`, else what the cell displays. */
  const copyTextAt = (rowIndex: number, colIndex: number): string => {
    const column = navColumns[colIndex];
    const edit = column ? metaOf(column).edit : undefined;
    const row = rowAt(rowIndex);
    if (edit && row) return formatCellValue(edit, row);
    const rowId = bodyRowIds[rowIndex];
    const columnId = navColumnIds[colIndex];
    const tr = Array.from(tbodyRef.current?.children ?? []).find(
      (element) => element.getAttribute("data-row-id") === rowId,
    );
    const td = Array.from(tr?.children ?? []).find(
      (element) => element.getAttribute("data-col") === columnId,
    );
    return td?.textContent?.trim() ?? "";
  };

  const planGrid: PlanGrid<TRow> = {
    rowCount: bodyRowIds.length,
    colCount: navColumnIds.length,
    rowAt: (index) => {
      const id = bodyRowIds[index];
      const row = id === undefined ? undefined : rowStates.get(id)?.row;
      return id !== undefined && row ? { id, row } : undefined;
    },
    columnIdAt: (index) => navColumnIds[index],
    editAt: editableAt,
    textAt: copyTextAt,
  };

  /**
   * Applies a plan through the same optimistic + `save` path as a single edit:
   * every cell shows at once (one render, no flicker), then saves run with
   * bounded concurrency. A failed cell rolls back alone and is reported.
   */
  const applyPlan = async (
    plan: RangePlan<TRow>,
    source: GridChangeSource,
  ): Promise<void> => {
    const verb = source === "paste" ? "paste" : source === "fill" ? "fill" : "clear";
    const notice = describePlan(plan, verb);
    setRangeNotice(notice);
    if (notice) setLiveMessage(notice);
    const { changes } = plan;
    if (changes.length === 0) {
      if (!notice) setLiveMessage("Nothing to change.");
      return;
    }

    clearRowErrors(changes.map((change) => change.rowId));
    const pending = changes.map((change: PlannedChange<TRow>) => ({
      change,
      seq: applyOptimisticEdit(change.rowId, change.edit, change.next),
    }));
    const results = await runGrouped(
      pending,
      ({ change }) => change.rowId,
      ({ change, seq }) =>
        persistEdit(change.rowId, change.row, change.edit, change.next, seq),
    );

    const failuresByRow = new Map<string, string[]>();
    const records = pending.map(({ change }, index) => {
      const result = results[index];
      if (!result.ok) {
        const label = labelOf(navColumns[change.colIndex]);
        failuresByRow.set(change.rowId, [
          ...(failuresByRow.get(change.rowId) ?? []),
          `${label}: ${result.error}`,
        ]);
      }
      return {
        rowId: change.rowId,
        columnId: change.columnId,
        field: change.edit.field as string,
        prev: change.prev,
        next: change.next,
        status: result.ok ? ("saved" as const) : ("failed" as const),
        error: result.ok ? undefined : result.error,
      };
    });
    const failed = records.filter((record) => record.status === "failed").length;
    if (failuresByRow.size > 0) {
      setErrors((previous) => {
        const map = new Map(previous);
        for (const [rowId, messages] of failuresByRow) map.set(rowId, messages.join("; "));
        return map;
      });
    }
    onChangeSet?.(createChangeSet(source, records));
    const saved = records.length - failed;
    setLiveMessage(
      `${notice ? `${notice} ` : ""}${saved} ${saved === 1 ? "cell" : "cells"} updated${failed > 0 ? `, ${failed} failed` : ""}.`,
    );
  };

  const runClear = (range: GridRange, source: GridChangeSource = "clear") =>
    applyPlan(planClear(range, planGrid, rangeLimit), source);

  /** Ctrl+D: the top row of the range fills the rest; a lone cell copies the one above. */
  const runFillDown = () => {
    if (!rangeRect || readOnly) return;
    if (rangeRect.bottom > rangeRect.top) {
      void applyPlan(
        planFill(
          { ...rangeRect, bottom: rangeRect.top },
          { from: rangeRect.top + 1, to: rangeRect.bottom },
          planGrid,
          rangeLimit,
        ),
        "fill",
      );
    } else if (rangeRect.top > 0) {
      void applyPlan(
        planFill(
          { ...rangeRect, top: rangeRect.top - 1, bottom: rangeRect.top - 1 },
          { from: rangeRect.top, to: rangeRect.top },
          planGrid,
          rangeLimit,
        ),
        "fill",
      );
    }
  };

  const idsAt = (position: GridPosition) => ({
    rowId: bodyRowIds[position.row],
    columnId: navColumnIds[position.col],
  });

  /**
   * Settle the open editor. With `value` omitted the draft text is parsed; an
   * unparseable draft keeps the editor open and reports why. Returns whether the
   * edit was settled.
   */
  const commitActiveEdit = (
    value?: GridCellValue,
    move?: "down" | "up" | "right" | "left",
  ): boolean => {
    if (!activePosition) return false;
    const edit = editableAt(activePosition.row, activePosition.col);
    const row = rowAt(activePosition.row);
    const id = bodyRowIds[activePosition.row];
    if (!edit || !row || id === undefined) return false;

    let next = value;
    if (next === undefined) {
      const parsed = parseCellText(edit, sheetState.draftText, row);
      if (!parsed.ok) {
        dispatchSheet({ type: "setEditError", error: parsed.error });
        setLiveMessage(parsed.error);
        return false;
      }
      next = parsed.value;
    }

    editSettled.current = true;
    if (next !== edit.getValue(row)) void commitEdit(id, row, edit, next);
    dispatchSheet({ type: "endEdit", refocus: true });

    if (move) {
      const target: GridPosition | null =
        move === "right" || move === "left"
          ? nextPosition(
              activePosition,
              { type: "tab", direction: move === "right" ? 1 : -1 },
              gridDimensions,
            )
          : nextPosition(
              activePosition,
              { type: "move", rows: move === "down" ? 1 : -1, cols: 0 },
              gridDimensions,
            );
      if (target) focusCellAt(target);
    }
    return true;
  };

  const beginEdit = (position: GridPosition, text?: string) => {
    const edit = editableAt(position.row, position.col);
    const row = rowAt(position.row);
    const id = bodyRowIds[position.row];
    if (!edit || !row || id === undefined) return;

    if (edit.kind === "checkbox") {
      // A checkbox has no editor: Enter / F2 / Space flip it in place.
      void commitEdit(id, row, edit, !edit.getValue(row));
      return;
    }
    editSettled.current = false;
    dispatchSheet({
      type: "startEdit",
      text: text ?? formatCellValue(edit, row),
    });
  };

  const handleBodyKeyDown = (event: React.KeyboardEvent<HTMLTableSectionElement>) => {
    if (!sheet || !activePosition) return;
    const target = event.target as Element;
    // A portaled listbox is a React child but not a DOM descendant. Its own
    // keys (arrows, Enter, Esc) belong to it.
    if (!event.currentTarget.contains(target)) return;

    const cell = target.closest<HTMLElement>("td[data-col]");
    const inActiveCell = cell?.dataset.sheetActive === "true";
    if (sheetState.mode === "nav") {
      // Only the cell itself is driven. A button inside it that has focus
      // (reached by clicking it) keeps its native Enter / Space behaviour.
      if (target !== cell) return;
    } else if (!inActiveCell) {
      return;
    }

    const action = resolveGridKey(event, sheetState.mode);
    if (!action) return;

    switch (action.type) {
      case "move":
      case "moveTo":
      case "page":
      case "tab": {
        const next = nextPosition(activePosition, action, gridDimensions);
        // A null Tab means "past the last editable cell": let the browser leave
        // the grid so it stays one tab stop rather than a keyboard trap.
        if (!next) return;
        event.preventDefault();
        focusCellAt(next);
        return;
      }
      case "startEdit":
        if (!editableAt(activePosition.row, activePosition.col)) return;
        event.preventDefault();
        beginEdit(activePosition, action.text);
        return;
      case "space": {
        const edit = editableAt(activePosition.row, activePosition.col);
        if (edit?.kind !== "checkbox") return;
        event.preventDefault();
        beginEdit(activePosition);
        return;
      }
      case "extend": {
        const corner = moveCorner(
          rangeEndPosition ?? activePosition,
          { rows: action.rows, cols: action.cols },
          gridDimensions,
        );
        event.preventDefault();
        dispatchSheet({ type: "extendRange", cell: idsAt(corner) });
        const range = selectionRange(activePosition, corner);
        const rowsSpan = range.bottom - range.top + 1;
        const colsSpan = range.right - range.left + 1;
        setLiveMessage(
          `Selected ${rowsSpan} ${rowsSpan === 1 ? "row" : "rows"} by ${colsSpan} ${colsSpan === 1 ? "column" : "columns"}.`,
        );
        return;
      }
      case "collapse":
        if (!multiRange) return;
        event.preventDefault();
        dispatchSheet({ type: "collapseRange" });
        return;
      case "fillDown":
        // Always claim Ctrl+D: the browser's "bookmark this page" is never wanted here.
        event.preventDefault();
        runFillDown();
        return;
      case "clear": {
        if (multiRange) {
          if (readOnly) return;
          event.preventDefault();
          void runClear(multiRange);
          return;
        }
        const edit = editableAt(activePosition.row, activePosition.col);
        const row = rowAt(activePosition.row);
        const id = bodyRowIds[activePosition.row];
        if (!edit || !row || id === undefined) return;
        event.preventDefault();
        const cleared = parseCellText(edit, "", row);
        if (!cleared.ok) {
          setLiveMessage(cleared.error);
          return;
        }
        if (cleared.value !== edit.getValue(row)) {
          void commitEdit(id, row, edit, cleared.value);
        }
        return;
      }
      case "openDetail": {
        const row = rowAt(activePosition.row);
        if (!row || !onOpenRow) return;
        event.preventDefault();
        onOpenRow(row);
        return;
      }
      case "commit":
        event.preventDefault();
        commitActiveEdit(undefined, action.move);
        return;
      case "cancel":
        event.preventDefault();
        editSettled.current = true;
        dispatchSheet({ type: "endEdit", refocus: true });
        return;
    }
  };

  // ── Clipboard ─────────────────────────────────────────────────────────────
  // `copy` / `cut` / `paste` events on the body: no async Clipboard API, so no
  // permission prompt, and text/plain only (Sheets also writes text/html; reading
  // none of it avoids HTML parsing). While an editor is open the native input
  // behaviour wins.
  const handleBodyCopy = (
    event: React.ClipboardEvent<HTMLTableSectionElement>,
    cut: boolean,
  ) => {
    if (!sheet || !rangeRect || sheetState.mode === "edit") return;
    if (cut && readOnly) return;

    let clearPlan: RangePlan<TRow> | null = null;
    if (cut) {
      clearPlan = planClear(rangeRect, planGrid, rangeLimit);
      if (clearPlan.overLimit) {
        // Refuse the whole cut: copying but not clearing would look like it worked.
        event.preventDefault();
        const message = describePlan(clearPlan, "cut");
        setRangeNotice(message);
        if (message) setLiveMessage(message);
        return;
      }
    }
    event.preventDefault();
    event.clipboardData.setData(
      "text/plain",
      formatTsv(rangeToMatrix(rangeRect, copyTextAt)),
    );
    if (clearPlan) void applyPlan(clearPlan, "cut");
    else setLiveMessage("Copied.");
  };

  const handleBodyPaste = (event: React.ClipboardEvent<HTMLTableSectionElement>) => {
    if (!sheet || readOnly || !rangeRect || sheetState.mode === "edit") return;
    const matrix = parseTsv(event.clipboardData.getData("text/plain"));
    if (matrix.length === 0) return;
    event.preventDefault();
    void applyPlan(planPaste(matrix, rangeRect, planGrid, rangeLimit), "paste");
  };

  // ── Pointer: drag-select and the fill handle ──────────────────────────────
  // Mouse events on the body cells only. Column reorder (dnd-kit) is armed by
  // listeners on the header drag handles alone, so nothing here can start it.
  const pointerDrag = React.useRef<
    { kind: "range" } | { kind: "fill"; source: GridRange } | null
  >(null);

  const endPointerDrag = React.useCallback(() => {
    const drag = pointerDrag.current;
    if (!drag) return;
    pointerDrag.current = null;
    if (drag.kind === "fill") dispatchSheet({ type: "setFillPreview", rowIndex: null });
  }, [dispatchSheet]);

  // A release anywhere (even outside the grid) ends the drag. The React `mouseup`
  // on the body runs first, so a fill dropped on the body still applies.
  React.useEffect(() => {
    if (!sheet) return;
    document.addEventListener("mouseup", endPointerDrag);
    return () => document.removeEventListener("mouseup", endPointerDrag);
  }, [sheet, endPointerDrag]);

  const handleBodyMouseDown = (event: React.MouseEvent<HTMLTableSectionElement>) => {
    if (!sheet || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest('[data-sheet-editing="true"]')) return;

    if (target.closest("[data-fill-handle]")) {
      if (readOnly || !rangeRect) return;
      // Keep DOM focus on the active cell while the handle is dragged.
      event.preventDefault();
      pointerDrag.current = { kind: "fill", source: rangeRect };
      return;
    }

    const hit = cellFromEvent(event.target);
    if (!hit) return;
    // With an editor open, a press elsewhere settles it through blur + focus as
    // before; the range then starts from the focus handler's `activate`.
    if (sheetState.mode === "edit") return;

    if (event.shiftKey && sheetState.active) {
      // Without this the browser moves focus and starts a text selection.
      event.preventDefault();
      dispatchSheet({ type: "extendRange", cell: { rowId: hit.rowId, columnId: hit.columnId } });
      return;
    }
    dispatchSheet({
      type: "beginPointer",
      cell: { rowId: hit.rowId, columnId: hit.columnId },
      rowIndex: hit.row,
    });
    pointerDrag.current = { kind: "range" };
  };

  const handleBodyMouseMove = (event: React.MouseEvent<HTMLTableSectionElement>) => {
    const drag = pointerDrag.current;
    if (!sheet || !drag) return;
    if (event.buttons === 0) {
      // The button was released outside the window: treat the drag as over.
      endPointerDrag();
      return;
    }
    const hit = cellFromEvent(event.target);
    if (!hit) return;
    if (drag.kind === "range") {
      dispatchSheet({ type: "extendRange", cell: { rowId: hit.rowId, columnId: hit.columnId } });
    } else {
      dispatchSheet({
        type: "setFillPreview",
        rowIndex: hit.row > drag.source.bottom ? hit.row : null,
      });
    }
  };

  const handleBodyMouseUp = () => {
    const drag = pointerDrag.current;
    if (!sheet || !drag || drag.kind !== "fill") return;
    const to = sheetState.fillTo;
    if (to !== null && to > drag.source.bottom) {
      void applyPlan(
        planFill(drag.source, { from: drag.source.bottom + 1, to }, planGrid, rangeLimit),
        "fill",
      );
      // The selection grows to cover what was filled.
      dispatchSheet({
        type: "beginPointer",
        cell: idsAt({ row: drag.source.top, col: drag.source.left }),
        rowIndex: drag.source.top,
      });
      dispatchSheet({
        type: "extendRange",
        cell: idsAt({ row: to, col: drag.source.right }),
      });
    }
  };

  const cellFromEvent = (target: EventTarget) => {
    const cell = (target as Element).closest?.<HTMLElement>("td[data-col]");
    const rowId = cell?.parentElement?.getAttribute("data-row-id");
    const columnId = cell?.getAttribute("data-col");
    if (!cell || !rowId || !columnId || columnId === SELECTION_COLUMN_ID) return null;
    const row = bodyRowIds.indexOf(rowId);
    const col = navColumnIds.indexOf(columnId);
    return row < 0 || col < 0 ? null : { rowId, columnId, row, col };
  };

  // Keep the active cell in step with wherever DOM focus lands: a click, a
  // Tab into the grid, or a click on a control inside a cell.
  const handleBodyFocus = (event: React.FocusEvent<HTMLTableSectionElement>) => {
    if (!sheet) return;
    const hit = cellFromEvent(event.target);
    if (!hit) return;
    dispatchSheet({
      type: "activate",
      cell: { rowId: hit.rowId, columnId: hit.columnId },
      rowIndex: hit.row,
    });
  };

  const handleBodyDoubleClick = (event: React.MouseEvent<HTMLTableSectionElement>) => {
    if (!sheet) return;
    const hit = cellFromEvent(event.target);
    if (!hit || !editableAt(hit.row, hit.col)) return;
    dispatchSheet({
      type: "activate",
      cell: { rowId: hit.rowId, columnId: hit.columnId },
      rowIndex: hit.row,
    });
    beginEdit({ row: hit.row, col: hit.col });
  };

  // Move DOM focus to the active cell after a keyboard-driven change. Keyed on
  // `focusSeq` so an RSC re-delivery or a pointer activation never steals focus.
  React.useEffect(() => {
    if (!sheet || sheetState.focusSeq === 0) return;
    const focusActive = () => {
      const cell = tbodyRef.current?.querySelector<HTMLElement>(
        'td[data-sheet-active="true"]',
      );
      cell?.focus();
    };
    focusActive();
    // base-ui returns focus to its (now unmounted) trigger as a listbox closes;
    // if that left focus on <body>, take it back one frame later.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body) focusActive();
    });
    return () => cancelAnimationFrame(frame);
  }, [sheet, sheetState.focusSeq]);

  // Keep the moving corner of a range visible as Shift+Arrow extends it.
  React.useEffect(() => {
    if (!sheet || !rangeEndPosition) return;
    const tr = Array.from(tbodyRef.current?.children ?? []).find(
      (element) => element.getAttribute("data-row-id") === bodyRowIds[rangeEndPosition.row],
    );
    const td = Array.from(tr?.children ?? []).find(
      (element) => element.getAttribute("data-col") === navColumnIds[rangeEndPosition.col],
    );
    (td as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [sheet, rangeEndPosition, bodyRowIds, navColumnIds]);

  // One tab stop. Widgets inside a cell (the Tasks title button) would each be
  // their own stop; take them out of the tab order unless their cell is being
  // edited. They stay clickable. Runs after every render because cell content is
  // owned by the columns, which this component does not control.
  React.useEffect(() => {
    if (!sheet) return;
    const focusable = tbodyRef.current?.querySelectorAll<HTMLElement>(
      `td:not([data-col="${SELECTION_COLUMN_ID}"]) :is(a[href], button, input, select, textarea, [tabindex]):not([tabindex="-1"])`,
    );
    focusable?.forEach((element) => {
      if (element.closest('[data-sheet-editing="true"]')) return;
      element.setAttribute("tabindex", "-1");
    });
  });

  const fill = height === "fill";

  return (
    <div
      className={cn("flex flex-col gap-3", fill && "min-h-0 flex-1", className)}
      data-testid="data-grid"
      data-height={height}
      // A custom property rather than a second style channel on the shared
      // `Table` primitive, whose `style` prop lands on the table element
      // itself rather than on the scrolling container that needs the cap.
      style={
        maxHeight
          ? ({ "--data-grid-max-h": maxHeight } as React.CSSProperties)
          : undefined
      }
    >
      <div aria-live="polite" className="sr-only" data-testid="grid-live-region">
        {liveMessage}
      </div>

      {toolbar && (() => {
        const toolbarNode = (
          <DataGridToolbar
            leading={toolbarLeading}
            searchDisplay={searchDisplay}
            compact={Boolean(toolbarPortalId)}
            search={search}
            filters={filters}
            onClearFilters={onClearFilters}
            columns={columnOptions}
            onToggleColumn={(id, visible) => preferences.toggleColumn(id, visible)}
            onMoveColumn={preferences.moveColumn}
            onResetColumns={preferences.reset}
            actions={toolbarActions}
          />
        );
        return toolbarPortal
          ? createPortal(toolbarNode, toolbarPortal)
          : toolbarPortalId
            ? null
            : toolbarNode;
      })()}

      {errorMessages.length > 0 && (
        <div
          role="alert"
          data-testid="grid-error-strip"
          // `shrink-0`: in fill mode this is a flex sibling of a `flex-1`
          // scroll viewport and would otherwise be compressed away.
          className="flex shrink-0 items-start gap-2 rounded-lg border border-status-danger-surface bg-status-danger-surface px-3 py-2 text-xs text-status-danger"
        >
          <div className="flex-1 space-y-0.5">
            {errorMessages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss errors"
            data-testid="grid-error-dismiss"
            onClick={() => setErrors(new Map())}
          >
            <X />
          </Button>
        </div>
      )}

      {sheet && rangeNotice && (
        <div
          role="status"
          data-testid="grid-range-notice"
          className="flex shrink-0 items-start gap-2 rounded-lg border border-status-warning-surface bg-status-warning-surface px-3 py-2 text-xs text-status-warning"
        >
          <span className="flex-1">{rangeNotice}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss message"
            data-testid="grid-range-notice-dismiss"
            onClick={() => setRangeNotice(null)}
          >
            <X />
          </Button>
        </div>
      )}

      {staleCount > 0 && (
        <div
          data-testid="grid-stale-strip"
          className="flex shrink-0 items-center gap-2 rounded-lg border border-status-warning-surface bg-status-warning-surface px-3 py-2 text-xs text-status-warning"
        >
          <span className="flex-1">
            {staleCount} item{staleCount === 1 ? "" : "s"} no longer match
            {staleCount === 1 ? "es" : ""} your filters
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="grid-refresh"
            onClick={() => onRefresh?.()}
          >
            <RefreshCw />
            Refresh
          </Button>
        </div>
      )}

      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        {/*
          `table-fixed` is required, not cosmetic. Under the default
          `table-layout: auto` the `<colgroup>` widths below are only hints, and
          a cell's intrinsic min-content width wins — one long description in a
          text column silently widens the table past its container and the
          `overflow-x-auto` wrapper in `components/ui/table.tsx` turns that into
          a horizontal scrollbar. Measured at 1280x800 before this: table 1186px
          inside a 996px container. With fixed layout the `<col>` widths are
          authoritative, columns without one share the remainder, and cell
          content clips via its own `truncate` / `line-clamp-*`.
        */}
        {/*
          The scroll viewport is `table-container` itself, never an outer div.
          `overflow-x: auto` already makes that wrapper a scroll container on
          BOTH axes, so it is the nearest scrolling ancestor and therefore the
          box a sticky `<th>` resolves against — a bounded, scrolling wrapper
          placed outside it takes the sticky header away with the content.

          `overflow-y-auto` rather than `overflow-auto` on purpose: it leaves
          the primitive's literal `overflow-x-auto` in place instead of relying
          on class-merge order to replace it, so the horizontal behaviour the
          `table-fixed` comment below describes is provably unchanged.

          `isolate` gives the grid its own stacking context so the sticky header
          (z-20 locally) can never compete with `WorkspacePage`'s own
          `sticky top-0 z-20` header in the root stacking context.
        */}
        <Table
          className="table-fixed"
          // `aria-rowcount` / `aria-colcount` use the SERVER total: only one
          // page is in the DOM, and the +1 is the header row.
          role={sheet ? "grid" : undefined}
          aria-label={sheet ? caption : undefined}
          aria-rowcount={sheet ? total + 1 : undefined}
          aria-colcount={sheet ? visibleColumns.length : undefined}
          aria-multiselectable={sheet ? true : undefined}
          // `undefined` in mobile mode, where the single `colSpan` card must
          // fill the viewport rather than force the desktop sum into scroll.
          style={tableMinWidth ? { minWidth: tableMinWidth } : undefined}
          containerClassName={cn(
            "isolate",
            fill && "min-h-0 flex-1 overflow-y-auto",
            !fill && maxHeight && "max-h-(--data-grid-max-h) overflow-y-auto",
          )}
        >
          <TableCaption className="sr-only">{caption}</TableCaption>
          <colgroup>
            {mobileMode ? (
              // One column, no fixed width: the card fills the viewport.
              <col />
            ) : (
              visibleColumns.map((column) => {
                const width = metaOf(column).width;
                return (
                  <col
                    key={column.id}
                    // Widths are static per column id, so they are identical in
                    // the pre-hydration frame and the frame after stored column
                    // preferences load. Only presence and order can flick.
                    //
                    // `meta.minWidth` is deliberately NOT emitted here. A
                    // `min-width` on a `<col>` is not honoured under fixed
                    // layout, and giving a flexible column a `width` would stop
                    // it absorbing the slack at wide viewports. Its floor is
                    // enforced by the table's `min-width` instead.
                    style={width ? { width } : undefined}
                  />
                );
              })
            )}
          </colgroup>

          {!mobileMode && (
            <TableHeader>
              <SortableContext
                items={visibleColumns.map((column) => column.id as string)}
                strategy={horizontalListSortingStrategy}
              >
                <TableRow aria-rowindex={sheet ? 1 : undefined}>
                  {visibleColumns.map((column) => {
                    const meta = metaOf(column);
                    const id = column.id as string;
                    if (id === SELECTION_COLUMN_ID) {
                      return (
                        <TableHead
                          key={id}
                          data-testid={`grid-head-${id}`}
                          data-col={id}
                          className={STICKY_HEADER_CELL_CLASS}
                        >
                          <span className="sr-only">Select</span>
                        </TableHead>
                      );
                    }
                    const sortKey = meta.sortable
                      ? (meta.sortKey ?? id)
                      : meta.sortKey;
                    return (
                      <DataGridHeaderCell
                        key={id}
                        columnId={id}
                        label={
                          typeof column.header === "string"
                            ? column.header
                            : labelOf(column)
                        }
                        labelText={labelOf(column)}
                        sortKey={sortKey}
                        sorted={
                          sortKey && sort?.key === sortKey ? sort.dir : false
                        }
                        onSort={onSortChange}
                        align={meta.align}
                        movable={meta.hideable !== false}
                        className={meta.headerClassName}
                      />
                    );
                  })}
                </TableRow>
              </SortableContext>
            </TableHeader>
          )}

          <TableBody
            ref={tbodyRef}
            onKeyDown={sheet ? handleBodyKeyDown : undefined}
            onFocus={sheet ? handleBodyFocus : undefined}
            onDoubleClick={sheet ? handleBodyDoubleClick : undefined}
            onMouseDown={sheet ? handleBodyMouseDown : undefined}
            onMouseMove={sheet ? handleBodyMouseMove : undefined}
            onMouseUp={sheet ? handleBodyMouseUp : undefined}
            onCopy={sheet ? (event) => handleBodyCopy(event, false) : undefined}
            onCut={sheet ? (event) => handleBodyCopy(event, true) : undefined}
            onPaste={sheet ? handleBodyPaste : undefined}
          >
            {bodyRows.length === 0 && (
              <TableRow data-testid="grid-empty-row">
                <TableCell colSpan={columnCount} className="py-10 text-center">
                  {emptyState ?? (
                    <span className="text-sm text-text-subtle">No results</span>
                  )}
                </TableCell>
              </TableRow>
            )}

            {bodyRows.map((tableRow, rowIndex) => {
              const id = tableRow.id;
              const state = rowStates.get(id);
              const row = (state?.row ?? tableRow.original) as TRow;

              const rowProps = {
                "data-testid": "grid-row",
                "data-row-id": id,
                "data-stale": state?.stale ? "true" : undefined,
                "data-pending": state?.pending ? "true" : undefined,
                "data-error": state?.error ? "true" : undefined,
                "data-state": state?.selected ? ("selected" as const) : undefined,
                // 1-based and offset by the header row and any earlier pages.
                "aria-rowindex": sheet
                  ? (page - 1) * pageSize + rowIndex + 2
                  : undefined,
              };

              const extraRowClass = rowClassName?.(
                row,
                state as GridRowState<TRow>,
              );

              if (mobileMode) {
                return (
                  <TableRow
                    key={id}
                    {...rowProps}
                    className={cn("align-top", extraRowClass)}
                  >
                    <TableCell
                      colSpan={columnCount}
                      data-testid="grid-cell-mobile"
                      data-col="__mobile"
                      className="w-full whitespace-normal p-0"
                    >
                      {renderMobileRow?.(row, state as GridRowState<TRow>)}
                    </TableCell>
                  </TableRow>
                );
              }

              const cellsByColumn = tableRow.getVisibleCellsByColumnId();

              return (
                <TableRow key={id} {...rowProps} className={extraRowClass}>
                  {visibleColumns.map((column) => {
                    const columnId = column.id as string;
                    const meta = metaOf(column);

                    if (columnId === SELECTION_COLUMN_ID) {
                      return (
                        // Deliberately not clipped: TableCell drops its right
                        // padding for a checkbox cell, and the Checkbox extends
                        // its pointer target 12px past its own box with
                        // `after:-inset-x-3`. Clipping here would shrink a real
                        // hit area to buy nothing — the cell holds a fixed-size
                        // control, never text.
                        <TableCell
                          key={columnId}
                          data-testid={`grid-cell-${columnId}`}
                          data-col={columnId}
                          role={sheet ? "gridcell" : undefined}
                          aria-readonly={sheet ? true : undefined}
                        >
                          <Checkbox
                            checked={state?.selected ?? false}
                            aria-label={
                              selection?.rowLabel?.(row) ?? `Select row ${id}`
                            }
                            onCheckedChange={(checked) => {
                              if (!selection) return;
                              const current = new Set(selection.selectedIds);
                              if (checked) current.add(id);
                              else current.delete(id);
                              selection.onChange([...current]);
                            }}
                          />
                        </TableCell>
                      );
                    }

                    const cell = cellsByColumn[columnId];

                    const colIndex = navColumnIds.indexOf(columnId);
                    const isActiveCell =
                      sheet &&
                      activePosition !== null &&
                      activePosition.row === rowIndex &&
                      activePosition.col === colIndex;
                    const isEditingCell = isActiveCell && editing;
                    const inRange =
                      sheet && multiRange !== null && rangeContains(multiRange, rowIndex, colIndex);
                    const inFillPreview =
                      sheet &&
                      fillPreview !== null &&
                      rangeRect !== null &&
                      rowIndex >= fillPreview.from &&
                      rowIndex <= fillPreview.to &&
                      colIndex >= rangeRect.left &&
                      colIndex <= rangeRect.right;
                    const showFillHandle =
                      sheet &&
                      !readOnly &&
                      !editing &&
                      rangeRect !== null &&
                      rowIndex === rangeRect.bottom &&
                      colIndex === rangeRect.right &&
                      Boolean(editableAt(rowIndex, colIndex));
                    const sheetEdit = sheet ? editableAt(rowIndex, colIndex) : undefined;
                    // A legacy grid only knows the select editor. Other kinds
                    // are sheet-only, so there it falls back to the display cell.
                    const legacySelect =
                      !sheet && meta.edit?.kind === "select" ? meta.edit : undefined;

                    return (
                      <TableCell
                        key={columnId}
                        data-testid={`grid-cell-${columnId}`}
                        data-col={columnId}
                        data-error={
                          meta.edit && state?.error ? "true" : undefined
                        }
                        aria-invalid={
                          meta.edit && state?.error ? true : undefined
                        }
                        {...(sheet
                          ? {
                              role: "gridcell",
                              "aria-colindex": colIndex + 1,
                              "aria-readonly": !sheetEdit,
                              // Roving tabindex: exactly one cell is a tab stop.
                              tabIndex: isActiveCell ? 0 : -1,
                              "aria-selected": inRange ? true : undefined,
                              "data-range": inRange ? "true" : undefined,
                              "data-fill-preview": inFillPreview ? "true" : undefined,
                              "data-sheet-active": isActiveCell ? "true" : undefined,
                              "data-sheet-editing": isEditingCell ? "true" : undefined,
                            }
                          : {})}
                        className={cn(
                          // Before `cellClassName` so a column can still
                          // override the pair through its own classes — the
                          // Feedback grid's `whitespace-normal` already relies
                          // on exactly that merge order.
                          meta.overflow !== "visible" && CELL_CLIP_CLASS,
                          meta.align === "end" && "text-right",
                          sheet &&
                            "relative outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          // No native text selection while dragging a range; copy
                          // is ours, and an open editor keeps its own selection.
                          sheet && !isEditingCell && "select-none",
                          "data-[range=true]:bg-primary/10 data-[fill-preview=true]:bg-primary/5",
                          meta.cellClassName,
                        )}
                      >
                        {legacySelect ? (
                          <EditableCell
                            row={row}
                            edit={legacySelect}
                            readOnly={readOnly}
                            pending={state?.pending ?? false}
                            error={state?.error}
                            onCommit={(next) =>
                              void commitEdit(id, row, legacySelect, next)
                            }
                          />
                        ) : isEditingCell && sheetEdit ? (
                          <CellEditor
                            edit={sheetEdit}
                            row={row}
                            draftText={sheetState.draftText}
                            error={sheetState.editError}
                            onDraftChange={(text) =>
                              dispatchSheet({ type: "setDraft", text })
                            }
                            onChoose={(value) => commitActiveEdit(value)}
                            onDismiss={() => {
                              if (editSettled.current) return;
                              editSettled.current = true;
                              dispatchSheet({ type: "endEdit", refocus: true });
                            }}
                            onBlur={() => {
                              if (!editSettled.current) commitActiveEdit();
                            }}
                          />
                        ) : sheet && meta.edit && !column.cell ? (
                          <CellDisplay
                            edit={meta.edit}
                            row={row}
                            readOnly={!sheetEdit}
                            onToggle={(next) => void commitEdit(id, row, meta.edit!, next)}
                          />
                        ) : cell ? (
                          <table.FlexRender cell={cell} />
                        ) : null}
                        {showFillHandle && (
                          <span
                            aria-hidden
                            data-fill-handle
                            data-testid="grid-fill-handle"
                            className="absolute right-0 bottom-0 size-2.5 cursor-crosshair rounded-[2px] border border-background bg-primary"
                          />
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DndContext>

      {drafting && !readOnly && !isMobile && (
        <DraftArea modes={drafting} request={creationRequest} announce={setLiveMessage} />
      )}

      {pagination && (
        <DataGridPagination
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
          pageSizes={pageSizes}
          total={total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </div>
  );
}
