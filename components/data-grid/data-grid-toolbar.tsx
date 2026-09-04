"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  FacetedFilterMenu,
  type FacetedFilterGroup,
} from "@/components/patterns/faceted-filter-menu";
import { cn } from "@/lib/utils";
import { ColumnOptionsMenu, type ColumnOption } from "./column-options-menu";
import type { GridSearch } from "./types";

export type DataGridToolbarProps = {
  leading?: ReactNode;
  search?: GridSearch;
  filters?: readonly FacetedFilterGroup[];
  onClearFilters?: () => void;
  columns: readonly ColumnOption[];
  onToggleColumn: (id: string, visible: boolean) => void;
  onMoveColumn: (id: string, direction: -1 | 1) => void;
  onResetColumns: () => void;
  actions?: ReactNode;
  className?: string;
  searchDisplay?: "inline" | "popover";
  compact?: boolean;
};

const DEFAULT_DEBOUNCE_MS = 300;

/** Debounced text input that still honours external (back-button) changes. */
function DebouncedSearchInput({ search, autoFocus }: { search: GridSearch; autoFocus?: boolean }) {
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
        autoFocus={autoFocus}
        type="search"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        placeholder={search.placeholder ?? "Search"}
        aria-label={search.label ?? "Search"}
        data-testid="grid-search"
        className="pl-8"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => handleChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-text-subtle hover:text-text-primary"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function SearchPopover({ search }: { search: GridSearch }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Search feedback" />}>
        <Search />
        <span className="hidden sm:inline">Search</span>
        {search.value && <span className="size-1.5 rounded-full bg-primary" aria-label="Search active" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-2">
        <DebouncedSearchInput search={search} autoFocus />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DataGridToolbar({
  leading,
  search,
  filters,
  onClearFilters,
  columns,
  onToggleColumn,
  onMoveColumn,
  onResetColumns,
  actions,
  className,
  searchDisplay = "inline",
  compact,
}: DataGridToolbarProps) {
  return (
    <div
      data-testid="grid-toolbar"
      className={cn(
        compact ? "flex items-center gap-1.5" : "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className={compact ? "flex items-center gap-1.5" : "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"}>
        {leading}
        {search && (searchDisplay === "popover" ? <SearchPopover search={search} /> : <DebouncedSearchInput search={search} />)}
        {filters && filters.length > 0 && (
          <FacetedFilterMenu
            groups={[...filters]}
            onClearAll={() => onClearFilters?.()}
            compact={compact}
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <ColumnOptionsMenu
          columns={columns}
          onToggle={onToggleColumn}
          onMove={onMoveColumn}
          onReset={onResetColumns}
          compact={compact}
        />
        {actions}
      </div>
    </div>
  );
}
