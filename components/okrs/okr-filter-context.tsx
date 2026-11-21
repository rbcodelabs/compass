"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type Counts = { shown: number; total: number };

type OkrFilterValue = {
  query: string;
  setQuery: (query: string) => void;
  counts: Counts;
  setCounts: (counts: Counts) => void;
};

const OkrFilterContext = createContext<OkrFilterValue | null>(null);

const INERT: OkrFilterValue = {
  query: "",
  setQuery: () => {},
  counts: { shown: 0, total: 0 },
  setCounts: () => {},
};

/**
 * Shares the quick-filter text between the page header (which renders the input)
 * and the objectives list. Client-only state: no URL or server round trip per keystroke.
 */
export function OkrFilterProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [counts, setCountsState] = useState<Counts>({ shown: 0, total: 0 });
  const value = useMemo<OkrFilterValue>(
    () => ({
      query,
      setQuery,
      counts,
      // Skip no-op updates so the list reporting the same numbers cannot loop.
      setCounts: (next) =>
        setCountsState((prev) => (prev.shown === next.shown && prev.total === next.total ? prev : next)),
    }),
    [query, counts]
  );
  return <OkrFilterContext.Provider value={value}>{children}</OkrFilterContext.Provider>;
}

/** Outside a provider the filter is inert (empty query), so the list works unchanged. */
export function useOkrFilter(): OkrFilterValue {
  return useContext(OkrFilterContext) ?? INERT;
}
