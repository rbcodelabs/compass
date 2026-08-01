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
import { DiscoveryRailPanel } from "./discovery-rail-panel";
import { ObjectivePanel } from "./objective-panel";
import { KeyResultPanel } from "./key-result-panel";
import { SolutionPanel } from "./solution-panel";
import { AssumptionPanel } from "./assumption-panel";
import { RoadmapItemPanel } from "./roadmap-item-panel";
import { FeedbackPanel } from "./feedback-panel";

const PANEL_TITLES: Record<string, string> = {
  objective: "Objective",
  keyResult: "Key Result",
  opportunity: "Opportunity",
  solution: "Solution",
  assumption: "Assumption",
  experiment: "Experiment",
  roadmapItem: "Roadmap Item",
  feedback: "Feedback",
  "discovery-rail": "Discovery",
};

export function PanelShell() {
  const { panel, closePanel, orgSlug, workspaceSlug } = usePanelContext();
  const common = { orgSlug, workspaceSlug };

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
          {panel?.type === "objective" && <ObjectivePanel id={panel.id} {...common} />}
          {panel?.type === "keyResult" && <KeyResultPanel id={panel.id} {...common} />}
          {panel?.type === "opportunity" && (
            <OpportunityPanel opportunityId={panel.id} {...common} />
          )}
          {panel?.type === "solution" && <SolutionPanel id={panel.id} {...common} />}
          {panel?.type === "assumption" && <AssumptionPanel id={panel.id} {...common} />}
          {panel?.type === "experiment" && (
            <ExperimentPanel experimentId={panel.id} {...common} />
          )}
          {panel?.type === "roadmapItem" && <RoadmapItemPanel id={panel.id} {...common} />}
          {panel?.type === "feedback" && <FeedbackPanel id={panel.id} {...common} />}
          {panel?.type === "discovery-rail" && (
            <DiscoveryRailPanel activeOpportunityId={panel.id} {...common} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
