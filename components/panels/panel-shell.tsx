"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { usePanelContext } from "./panel-context";
import { ExperimentPanel } from "./experiment-panel";
import { OpportunityPanel } from "./opportunity-panel";

const PANEL_TITLES: Record<string, string> = {
  experiment: "Experiment",
  opportunity: "Opportunity",
};

export function PanelShell() {
  const { panel, closePanel, orgSlug, workspaceSlug } = usePanelContext();

  return (
    <Sheet open={panel !== null} onOpenChange={(open) => { if (!open) closePanel(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md flex flex-col gap-0 p-0 z-[60]"
        showCloseButton
      >
        <SheetHeader className="px-5 pt-5 pb-3 shrink-0 border-b">
          <SheetTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            {panel ? PANEL_TITLES[panel.type] ?? panel.type : ""}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto pt-4">
          {panel?.type === "experiment" && (
            <ExperimentPanel
              experimentId={panel.id}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          )}
          {panel?.type === "opportunity" && (
            <OpportunityPanel
              opportunityId={panel.id}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
