"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Per-user column chrome (which columns are shown, and in what order),
 * persisted in `localStorage` under `compass:grid:{gridId}:v1`.
 *
 * Deliberately **not** in the URL: a Compass URL is a shareable *query*, and
 * "which columns Rick likes" is not part of the query. Putting it there would
 * make every shared link carry someone else's chrome.
 *
 * Read happens in an effect, never during render, so the server frame and the
 * first client frame agree. The grid keeps `<colgroup>` widths static across
 * both frames, so only column presence and order visibly change.
 */

const PREFERENCES_VERSION = "v1";

export function gridPreferencesKey(gridId: string): string {
  return `compass:grid:${gridId}:${PREFERENCES_VERSION}`;
}

/** What is actually written to storage. */
export type StoredGridPreferences = {
  /** Column ids the user has hidden. */
  hidden: string[];
  /** Movable column ids, in the user's order. */
  order: string[];
};

/** The minimum a column must declare for reconciliation. */
export type GridPreferenceColumn = {
  id: string;
  /** `false` pins the column: it can be neither hidden nor moved. */
  hideable?: boolean;
};

export type GridPreferences = {
  /** Full column order, including pinned columns at their declared positions. */
  columnOrder: string[];
  /** TanStack `columnVisibility` map. Only ever contains `false` entries. */
  columnVisibility: Record<string, boolean>;
  /** True once the stored value has been read. Used only for persistence gating. */
  hydrated: boolean;
  toggleColumn: (id: string, visible?: boolean) => void;
  moveColumn: (id: string, direction: -1 | 1) => void;
  setColumnOrder: (order: string[]) => void;
  reset: () => void;
};

/** Read and validate the stored value. Corrupt or foreign data resets to null. */
export function readStoredPreferences(
  gridId: string,
): StoredGridPreferences | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(gridPreferencesKey(gridId));
  } catch {
    // Private mode / disabled storage. Preferences are a nicety, not a feature.
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<StoredGridPreferences>;
    const hidden = Array.isArray(candidate.hidden)
      ? candidate.hidden.filter((id): id is string => typeof id === "string")
      : [];
    const order = Array.isArray(candidate.order)
      ? candidate.order.filter((id): id is string => typeof id === "string")
      : [];
    return { hidden, order };
  } catch {
    // Corrupt JSON: drop it rather than throwing on every render.
    return null;
  }
}

/**
 * Fold a stored preference onto the columns that actually exist now.
 *
 * Rules:
 *  - unknown ids are dropped (a column was removed in a deploy);
 *  - new ids are appended (a column was added in a deploy);
 *  - `hideable: false` columns are never hidden and never move: they keep
 *    their declared index, and movable columns fill the slots around them.
 */
export function reconcilePreferences(
  stored: StoredGridPreferences | null,
  columns: readonly GridPreferenceColumn[],
): { columnOrder: string[]; columnVisibility: Record<string, boolean> } {
  const declared = columns.map((column) => column.id);
  const known = new Set(declared);
  const isPinned = new Map(
    columns.map((column) => [column.id, column.hideable === false] as const),
  );

  const movableDeclared = declared.filter((id) => !isPinned.get(id));

  // Order: stored movable ids first (unknowns dropped), then any new movable
  // ids in declared order.
  const storedMovable = (stored?.order ?? []).filter(
    (id) => known.has(id) && !isPinned.get(id),
  );
  const seen = new Set(storedMovable);
  const movableOrder = [
    ...storedMovable,
    ...movableDeclared.filter((id) => !seen.has(id)),
  ];

  // Rebuild the full order: pinned columns hold their declared index, movable
  // columns fill the remaining slots in the user's order.
  const columnOrder: string[] = [];
  let cursor = 0;
  for (const id of declared) {
    if (isPinned.get(id)) {
      columnOrder.push(id);
    } else {
      columnOrder.push(movableOrder[cursor] ?? id);
      cursor += 1;
    }
  }

  // Visibility: only movable, known columns may be hidden.
  const columnVisibility: Record<string, boolean> = {};
  for (const id of stored?.hidden ?? []) {
    if (!known.has(id) || isPinned.get(id)) continue;
    columnVisibility[id] = false;
  }

  return { columnOrder, columnVisibility };
}

/** The default (no stored preferences) state for a set of columns. */
function defaultPreferences(columns: readonly GridPreferenceColumn[]) {
  return reconcilePreferences(null, columns);
}

export function useGridPreferences(
  gridId: string,
  columns: readonly GridPreferenceColumn[],
): GridPreferences {
  // A stable signature so the effects below do not re-run on every render just
  // because the caller rebuilt its column array.
  const signature = columns
    .map((column) => `${column.id}:${column.hideable === false ? "0" : "1"}`)
    .join("|");

  // Normalised, referentially stable view of the columns. Recomputed only when
  // the signature changes, so every effect and callback below can depend on it
  // without a ref (reading a ref during render is not allowed).
  const stableColumns = useMemo(
    () =>
      columns.map((column) => ({
        id: column.id,
        hideable: column.hideable !== false,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature covers `columns`
    [signature],
  );

  const initial = useMemo(
    () => defaultPreferences(stableColumns),
    [stableColumns],
  );

  const [columnOrder, setOrderState] = useState<string[]>(initial.columnOrder);
  const [columnVisibility, setVisibilityState] = useState<Record<string, boolean>>(
    initial.columnVisibility,
  );
  const [hydrated, setHydrated] = useState(false);

  // Read stored preferences AFTER mount. Reading during render would make the
  // server HTML and the first client render disagree.
  useEffect(() => {
    const reconciled = reconcilePreferences(
      readStoredPreferences(gridId),
      stableColumns,
    );
    setOrderState(reconciled.columnOrder);
    setVisibilityState(reconciled.columnVisibility);
    setHydrated(true);
  }, [gridId, stableColumns]);

  // Persist. Only ever called from an explicit user action (toggle / move /
  // drag), never from an effect, so the pre-hydration default state can never
  // overwrite a stored preference.
  const persist = useCallback(
    (order: string[], visibility: Record<string, boolean>) => {
      if (typeof window === "undefined") return;
      const pinned = new Set(
        stableColumns.filter((column) => !column.hideable).map((column) => column.id),
      );
      const value: StoredGridPreferences = {
        hidden: Object.entries(visibility)
          .filter(([id, visible]) => visible === false && !pinned.has(id))
          .map(([id]) => id),
        order: order.filter((id) => !pinned.has(id)),
      };
      try {
        window.localStorage.setItem(gridPreferencesKey(gridId), JSON.stringify(value));
      } catch {
        // Storage full or blocked. Preferences degrade to session-only.
      }
    },
    [gridId, stableColumns],
  );

  const toggleColumn = useCallback(
    (id: string, visible?: boolean) => {
      const column = stableColumns.find((candidate) => candidate.id === id);
      if (!column || !column.hideable) return;
      setVisibilityState((previous) => {
        const nextVisible = visible ?? previous[id] === false;
        const next = { ...previous };
        if (nextVisible) delete next[id];
        else next[id] = false;
        persist(columnOrder, next);
        return next;
      });
    },
    [columnOrder, persist, stableColumns],
  );

  const applyOrder = useCallback(
    (next: string[]) => {
      setOrderState(next);
      persist(next, columnVisibility);
    },
    [columnVisibility, persist],
  );

  /** Move a column one slot, skipping over pinned columns. */
  const moveColumn = useCallback(
    (id: string, direction: -1 | 1) => {
      const pinned = new Set(
        stableColumns.filter((column) => !column.hideable).map((column) => column.id),
      );
      if (pinned.has(id)) return;
      const movable = columnOrder.filter((candidate) => !pinned.has(candidate));
      const from = movable.indexOf(id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= movable.length) return;
      const reordered = [...movable];
      reordered.splice(to, 0, ...reordered.splice(from, 1));

      let cursor = 0;
      const next = columnOrder.map((candidate) =>
        pinned.has(candidate) ? candidate : (reordered[cursor++] ?? candidate),
      );
      applyOrder(next);
    },
    [applyOrder, columnOrder, stableColumns],
  );

  const setColumnOrder = useCallback(
    (next: string[]) => {
      applyOrder(next);
    },
    [applyOrder],
  );

  const reset = useCallback(() => {
    const fresh = defaultPreferences(stableColumns);
    setOrderState(fresh.columnOrder);
    setVisibilityState(fresh.columnVisibility);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(gridPreferencesKey(gridId));
      } catch {
        // ignore
      }
    }
  }, [gridId, stableColumns]);

  return {
    columnOrder,
    columnVisibility,
    hydrated,
    toggleColumn,
    moveColumn,
    setColumnOrder,
    reset,
  };
}
