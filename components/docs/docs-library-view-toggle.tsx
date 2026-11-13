"use client";

import { Clock, LayoutDashboard, Shapes } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { WorkspaceViewSwitcher } from "@/components/patterns/workspace-header-controls";
import type { LibraryView } from "@/lib/docs-library";

/** Overview / By type / Recent for the Docs library. The overview is the default, so it is the absence of `?view=`. */
export function DocsLibraryViewToggle({ view }: { view: LibraryView }) {
  const { set } = useUrlState();

  return (
    <WorkspaceViewSwitcher
      value={view}
      label="Library view"
      onValueChange={(next) => set({ view: next === "overview" ? null : next })}
      options={[
        { value: "overview", label: "Overview", icon: <LayoutDashboard /> },
        { value: "by-type", label: "By type", icon: <Shapes /> },
        { value: "recent", label: "Recent", icon: <Clock /> },
      ]}
    />
  );
}
