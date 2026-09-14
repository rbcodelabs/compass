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
import { EditableCell } from "./editable-cell";
import { useGridPreferences } from "./use-grid-preferences";
import {
  gridFeatures,
  type GridColumnDef,
  type GridColumnMeta,
  type GridRowData,
  type GridRowState,
  type GridSearch,
  type GridSelection,
  type GridSort,
} from "./types";

/** Synthetic id of the injected selection column. */
export const SELECTION_COLUMN_ID = "__select";

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

type OverrideEntry<TRow> = { value: Partial<TRow>; pending: boolean };

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
  height = "natural",
  maxHeight,
  pagination = true,
  toolbar = true,
  rowClassName,
  emptyState,
  className,
}: DataGridProps<TRow>) {
  const isMobile = useIsMobile();
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
      for (const [id, entry] of previous) if (entry.pending) kept.set(id, entry);
      return kept.size === previous.size ? previous : kept;
    });
    setErrors((previous) => (previous.size === 0 ? previous : new Map()));
  }

  const mergedRows = React.useMemo(
    () =>
      rows.map((row) => {
        const entry = overrides.get(getRowId(row));
        return entry ? ({ ...row, ...entry.value } as TRow) : row;
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
        pending: entry?.pending ?? false,
        // Derived, never stored: it self-clears when the override clears, so
        // "server wins" needs no separate stale-reset path. A row is
        // deliberately NOT stale while pending, since the write may still fail.
        stale:
          Boolean(entry) &&
          !entry?.pending &&
          Boolean(rowMatchesFilters) &&
          !rowMatchesFilters?.(row),
        error: errors.get(id),
        selected: selected.has(id),
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getRowId is a caller-stable accessor
  }, [mergedRows, overrides, errors, rowMatchesFilters, selection?.selectedIds]);

  const commitEdit = React.useCallback(
    async (
      id: string,
      row: TRow,
      field: string,
      next: string,
      save: (row: TRow, next: string) => Promise<{ ok: true } | { ok: false; error: string }>,
    ) => {
      setErrors((previous) => {
        if (!previous.has(id)) return previous;
        const map = new Map(previous);
        map.delete(id);
        return map;
      });
      // Apply optimistically, synchronously, before awaiting anything.
      setOverrides((previous) => {
        const entry = previous.get(id);
        return new Map(previous).set(id, {
          value: { ...(entry?.value ?? {}), [field]: next } as Partial<TRow>,
          pending: true,
        });
      });

      const result = await save(row, next);

      if (result.ok) {
        setOverrides((previous) => {
          const entry = previous.get(id);
          if (!entry) return previous;
          return new Map(previous).set(id, { ...entry, pending: false });
        });
      } else {
        // Roll back entirely and surface the error inline. There is no toast
        // library in this repo and one is not being added.
        setOverrides((previous) => {
          const map = new Map(previous);
          map.delete(id);
          return map;
        });
        setErrors((previous) => new Map(previous).set(id, result.error));
      }
    },
    [],
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

  // ── Column drag reorder ───────────────────────────────────────────────────
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
                <TableRow>
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

          <TableBody>
            {bodyRows.length === 0 && (
              <TableRow data-testid="grid-empty-row">
                <TableCell colSpan={columnCount} className="py-10 text-center">
                  {emptyState ?? (
                    <span className="text-sm text-text-subtle">No results</span>
                  )}
                </TableCell>
              </TableRow>
            )}

            {bodyRows.map((tableRow) => {
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
                        <TableCell
                          key={columnId}
                          data-testid={`grid-cell-${columnId}`}
                          data-col={columnId}
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
                        className={cn(
                          meta.align === "end" && "text-right",
                          meta.cellClassName,
                        )}
                      >
                        {meta.edit ? (
                          <EditableCell
                            row={row}
                            edit={meta.edit}
                            pending={state?.pending ?? false}
                            error={state?.error}
                            onCommit={(next) =>
                              void commitEdit(
                                id,
                                row,
                                meta.edit!.field,
                                next,
                                meta.edit!.save,
                              )
                            }
                          />
                        ) : cell ? (
                          <table.FlexRender cell={cell} />
                        ) : null}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DndContext>

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
