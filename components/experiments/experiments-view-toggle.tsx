"use client";

import { Columns3, LayoutGrid } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { WorkspaceViewSwitcher } from "@/components/patterns/workspace-header-controls";
import type { ExperimentsView } from "@/lib/experiments/gallery";

export function ExperimentsViewToggle({ view }: { view: ExperimentsView }) {
  const { set } = useUrlState();

  function setView(next: string) {
    // "board" is the default view, so it is represented by the absence of the param rather than `?view=board`.
    // The gallery-only grouping goes with it: it means nothing on the board.
    set(next === "gallery" ? { view: "gallery" } : { view: null, groupBy: null });
  }

  return (
    <WorkspaceViewSwitcher
      value={view}
      onValueChange={setView}
      options={[
        { value: "board", label: "Board", icon: <Columns3 /> },
        { value: "gallery", label: "Gallery", icon: <LayoutGrid /> },
      ]}
    />
  );
}
