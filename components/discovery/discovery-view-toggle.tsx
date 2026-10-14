"use client";

import { Columns3, Table } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { WorkspaceViewSwitcher } from "@/components/patterns/workspace-header-controls";

export type DiscoveryView = "board" | "table";

export function DiscoveryViewToggle({ view }: { view: DiscoveryView }) {
  const { set } = useUrlState();

  return (
    <WorkspaceViewSwitcher
      value={view}
      onValueChange={(next) => set({ view: next === "table" ? "table" : null })}
      options={[
        { value: "board", label: "Board", icon: <Columns3 /> },
        { value: "table", label: "Table", icon: <Table /> },
      ]}
    />
  );
}
