"use client";

import { useEffect, useState } from "react";

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
import { TaskDetail } from "@/components/tasks/task-detail";

const PANEL_TITLES: Record<string, string> = {
  objective: "Objective",
  keyResult: "Key Result",
  opportunity: "Opportunity",
  solution: "Solution",
  assumption: "Assumption",
  experiment: "Experiment",
  roadmapItem: "Roadmap Item",
  feedback: "Feedback",
  task: "Task",
  "discovery-rail": "Discovery",
};

/**
 * Upper bound on how long the deep-link panel waits for a browser idle period
 * after `load`. Short enough that a foreground deep link is indistinguishable
 * from opening immediately, long enough to let the idle callback win normally.
 */
const HYDRATION_DEADLINE_MS = 200;

export function PanelShell() {
  const { panel, closePanel, orgSlug, workspaceSlug } = usePanelContext();
  const [hydrated, setHydrated] = useState(false);
  const common = { orgSlug, workspaceSlug };

  // A deep link is already present during SSR. Opening Base UI's modal Sheet
  // before hydration completes applies aria-hidden to the server-rendered
  // workspace tree before React compares it, producing a hydration mismatch.
  // Keep the controlled Sheet closed for the identical server/first-client
  // render, then honor the URL immediately after hydration.
  useEffect(() => {
    // Parent layout effects can run while a streamed page Suspense subtree is
    // still hydrating. Wait for the document load boundary and the browser's
    // next idle period before the modal applies aria-hidden to its siblings.
    // This is tied to hydration-relevant browser state, not a timing guess.
    //
    // The `load` event is the boundary that actually carries the correctness
    // property, and it fires regardless of tab visibility — so it is kept.
    // The idle callback is only a refinement on top of it, and refinements
    // must not be able to block the panel forever: requestIdleCallback (and
    // requestAnimationFrame, the old fallback) are deferred indefinitely in a
    // backgrounded tab, and rIC's own `timeout` is not reliably honored there
    // either. A `?detail=…` deep link opened in a background tab therefore
    // rendered no panel at all, even with readyState already "complete".
    //
    // So: still prefer idle, but race it against a plain timer, which is the
    // one scheduler a background tab always runs (throttled, never dropped).
    // Whichever wins, setHydrated(true) is idempotent. A plain
    // useEffect(() => setHydrated(true), []) would also be reliable, but it
    // discards the post-load/idle wait that keeps the modal from applying
    // aria-hidden to a sibling subtree that is still hydrating.
    let idleId: number | undefined;
    let timerId: number | undefined;
    const activate = () => setHydrated(true);
    const scheduleActivation = () => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(activate, {
          timeout: HYDRATION_DEADLINE_MS,
        });
      }
      timerId = window.setTimeout(activate, HYDRATION_DEADLINE_MS);
    };

    if (document.readyState === "complete") scheduleActivation();
    else window.addEventListener("load", scheduleActivation, { once: true });

    return () => {
      window.removeEventListener("load", scheduleActivation);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, []);

  return (
    <Sheet open={hydrated && panel !== null} onOpenChange={(open) => { if (!open) closePanel(); }}>
      <SheetContent
        side="right"
        // z-[60] is the panel layer — see the stacking-layer ladder in
        // app/globals.css. Overlays opened from inside this panel (dialogs at
        // 70, popups at 80) are laddered above it; anything portalled at 50
        // would paint underneath and refuse mouse clicks.
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
          {panel?.type === "task" && (
            <TaskDetail taskId={panel.id} variant="panel" {...common} />
          )}
          {panel?.type === "discovery-rail" && (
            <DiscoveryRailPanel activeOpportunityId={panel.id} {...common} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
