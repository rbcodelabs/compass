"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DiscoverySort = "manual" | "score";

/**
 * Board ordering toggle. "Manual" is the persisted `sortOrder` that drag-to-
 * reorder writes; "Score" is a read-only ranking view. The board disables
 * dragging entirely while Score is selected, so the two orderings can never
 * fight over the same column.
 *
 * Only rendered when the workspace has an active scoring model.
 */
export function DiscoverySortToggle({ sort }: { sort: DiscoverySort }) {
  const { set } = useUrlState();

  return (
    <Tabs
      value={sort}
      onValueChange={(next) => set({ sort: next === "score" ? "score" : null })}
    >
      <TabsList aria-label="Board ordering">
        <TabsTrigger value="manual">Manual</TabsTrigger>
        <TabsTrigger value="score">Sort by score</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
