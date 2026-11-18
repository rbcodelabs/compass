"use client";

import { CardSortQuickFilter } from "@/components/card-sort/card-sort-quick-filter";
import { useOkrFilter } from "@/components/okrs/okr-filter-context";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";

/** Real-time name filter for the header of the OKR cycle screen. */
export function OkrNameFilter() {
  const { query, setQuery, counts } = useOkrFilter();
  const labels = useLabels();
  return (
    <CardSortQuickFilter
      value={query}
      onChange={setQuery}
      shown={counts.shown}
      total={counts.total}
      label={`Filter ${labels.objective.lowerPlural} by name`}
    />
  );
}
