"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  FacetedFilterMenu,
  type FacetedFilterGroup,
} from "@/components/patterns/faceted-filter-menu";
import { cn } from "@/lib/utils";
import { ColumnOptionsMenu, type ColumnOption } from "./column-options-menu";
import type { GridSearch } from "./types";

export type DataGridToolbarProps = {
  search?: GridSearch;
  filters?: readonly FacetedFilterGroup[];
  onClearFilters?: () => void;
  columns: readonly ColumnOption[];
  onToggleColumn: (id: string, visible: boolean) => void;
  onMoveColumn: (id: string, direction: -1 | 1) => void;
  onResetColumns: () => void;
  actions?: ReactNode;
  className?: string;
};

const DEFAULT_DEBOUNCE_MS = 300;

/** Debounced text input that still honours external (back-button) changes. */
function DebouncedSearchInput({ search }: { search: GridSearch }) {
  const debounceMs = search.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [value, setValue] = useState(search.value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last value this input pushed outward. Kept in state, not a ref, so it
  // can legally be read during render.
  const [emitted, setEmitted] = useState<string | null>(null);

  // Adjust state during render (React's documented pattern) when the incoming
  // value changes. The `emitted` check makes the input ignore the echo of its
  // own debounced push: without it, a round trip that lands mid-keystroke would
  // yank the newest characters back out of the field.
  const [previousValue, setPreviousValue] = useState(search.value);
  if (previousValue !== search.value) {
    setPreviousValue(search.value);
    if (search.value !== emitted) setValue(search.value);
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function handleChange(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setEmitted(next);
      search.onChange(next);
    }, debounceMs);
  }

  return (
    <div className="relative w-full sm:w-64">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-subtle"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        placeholder={search.placeholder ?? "Search"}
        aria-label={search.label ?? "Search"}
        data-testid="grid-search"
        className="pl-8"
      />
    </div>
  );
}

export function DataGridToolbar({
  search,
  filters,
  onClearFilters,
  columns,
  onToggleColumn,
  onMoveColumn,
  onResetColumns,
  actions,
  className,
}: DataGridToolbarProps) {
  return (
    <div
      data-testid="grid-toolbar"
      className={cn(
        "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {search && <DebouncedSearchInput search={search} />}
        {filters && filters.length > 0 && (
          <FacetedFilterMenu
            groups={[...filters]}
            onClearAll={() => onClearFilters?.()}
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <ColumnOptionsMenu
          columns={columns}
          onToggle={onToggleColumn}
          onMove={onMoveColumn}
          onReset={onResetColumns}
        />
        {actions}
      </div>
    </div>
  );
}
