"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DiscoveryGroupBy = "status" | "opportunity";

export function DiscoveryGroupByToggle({ groupBy }: { groupBy: DiscoveryGroupBy }) {
  const { set } = useUrlState();

  return (
    <Tabs
      value={groupBy}
      onValueChange={(next) => set({ groupBy: next === "opportunity" ? "opportunity" : null })}
    >
      <TabsList>
        <TabsTrigger value="status">Status</TabsTrigger>
        <TabsTrigger value="opportunity">Opportunity</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
