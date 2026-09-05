"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DiscoveryView = "board" | "table";

export function DiscoveryViewToggle({ view }: { view: DiscoveryView }) {
  const { set } = useUrlState();

  return (
    <Tabs
      value={view}
      onValueChange={(next) => set({ view: next === "table" ? "table" : null })}
    >
      <TabsList>
        <TabsTrigger value="board">Board</TabsTrigger>
        <TabsTrigger value="table">Table</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
