"use client";

import { Columns3, List } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { WorkspaceViewSwitcher } from "@/components/patterns/workspace-header-controls";

type View = "board" | "list";

export function TasksViewToggle({ view }: { view: View }) {
  const { set } = useUrlState();

  function setView(next: string) {
    // "board" is the default view, so it is represented by the absence of the
    // param rather than `?view=board`.
    set({ view: next === "list" ? "list" : null });
  }

  return (
    <WorkspaceViewSwitcher
      value={view}
      onValueChange={setView}
      options={[
        { value: "board", label: "Board", icon: <Columns3 /> },
        { value: "list", label: "List", icon: <List /> },
      ]}
    />
  );
}
