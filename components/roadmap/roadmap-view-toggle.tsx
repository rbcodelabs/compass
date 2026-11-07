"use client";

import { ChartGantt, Columns3, LayoutGrid } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { WorkspaceViewSwitcher } from "@/components/patterns/workspace-header-controls";

type View = "board" | "timeline" | "gallery";

export function RoadmapViewToggle({ view }: { view: View }) {
  const { set } = useUrlState();

  function setView(next: string) {
    // "board" is the default view, so it is represented by the absence of the
    // param rather than `?view=board`.
    set({ view: next === "timeline" || next === "gallery" ? next : null });
  }

  return (
    <WorkspaceViewSwitcher
      value={view}
      onValueChange={setView}
      options={[
        { value: "board", label: "Board", icon: <Columns3 /> },
        { value: "timeline", label: "Timeline", icon: <ChartGantt /> },
        { value: "gallery", label: "Gallery", icon: <LayoutGrid /> },
      ]}
    />
  );
}
