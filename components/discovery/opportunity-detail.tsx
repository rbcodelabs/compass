"use client";

import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useEntityDetail, PanelSkeleton, PanelError, Section, type EditContext } from "@/components/panels/panel-parts";
import { Discussion } from "@/components/comments/discussion";
import { usePanelContext } from "@/components/panels/panel-context";
import { OpportunityHeader } from "./opportunity-header";
import { SolutionsList } from "./solutions-list";
import { AddSolutionForm } from "./add-solution-form";
import { OSTTreeView, type OSTSolutionNode } from "./ost-tree-view";
import { EvidenceList, type EvidenceListItem } from "./evidence-list";
import { AddEvidenceDialog } from "./add-evidence-dialog";
import { LinkedFeedback, type LinkedFeedbackItem } from "./linked-feedback";
import { ScoringPanel } from "./scoring-panel";
import { ScoreBadge } from "./score-badge";
import { toScoreSummary } from "@/lib/score-summary";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import { RequestDecisionLink } from "@/components/decisions/request-decision-link";
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link";
import { PmInterviewHistory } from "@/components/research/pm-interview-history";
import type { SolutionCardData } from "./solution-card";
import type { MemberData, OpportunityScoreData, ScoringModelData } from "@/lib/types";

type OpportunityData = ComponentProps<typeof OpportunityHeader>["opportunity"] & {
  workspaceId: string;
  solutions: Array<SolutionCardData & OSTSolutionNode>;
  evidence: EvidenceListItem[];
  feedback: LinkedFeedbackItem[];
  squads: ComponentProps<typeof OpportunityHeader>["squads"];
  availableKeyResults: ComponentProps<typeof OpportunityHeader>["availableKeyResults"];
  customFields: ComponentProps<typeof CustomFieldsPanel>["fields"];
  score: { normalizedScore: number; modelVersion: number } | null;
  existingScore: OpportunityScoreData | null;
  workspace: { scoringConfig: { scoringModel: ScoringModelData | null } | null } | null;
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
  pmInterviews: ComponentProps<typeof PmInterviewHistory>["interviews"];
  pmInterviewEnabled: boolean;
};

type Props = {
  opportunityId: string;
  orgSlug: string;
  workspaceSlug: string;
  variant: "panel" | "page";
  initialTab?: string;
};

/** Container width, not the mount point, determines the layout. Keying the
 * controller by identity also isolates drafts and pending loads on navigation. */
export function OpportunityDetail(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return <OpportunityDetailBody key={`${props.orgSlug}/${props.workspaceSlug}/${props.opportunityId}/${attempt}`} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

function OpportunityDetailBody({ opportunityId, orgSlug, workspaceSlug, variant, initialTab, onRetry }: Props & { onRetry: () => void }) {
  const { data, error, mutate, refresh } = useEntityDetail<OpportunityData>("opportunity", opportunityId, orgSlug, workspaceSlug);
  const { panel } = usePanelContext();
  const panelKey = panel ? `${panel.type}:${panel.id}` : null;
  const previousPanel = useRef(panelKey);
  useEffect(() => {
    // Nested panels still own their mutations. Reload the page's shared data
    // when returning from one, without replacing the discussion controller.
    if (variant === "page" && previousPanel.current && previousPanel.current !== panelKey) void refresh();
    previousPanel.current = panelKey;
  }, [panelKey, refresh, variant]);
  const discussionRef = useRef<HTMLElement>(null);
  const discussionId = useId();
  if (error && !data) return <div role="alert"><PanelError label="opportunity" /><Button variant="outline" onClick={onRetry}>Retry loading opportunity</Button></div>;
  if (!data) return <PanelSkeleton />;

  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunityId}`;
  const edit: EditContext = { type: "opportunity", id: opportunityId, orgSlug, workspaceSlug, onSaved: (next) => mutate(next as OpportunityData) };
  const scoringModel = data.workspace?.scoringConfig?.scoringModel ?? null;
  const customFields = data.customFields ?? [];
  const availableTabs = ["solutions", "evidence", "tree", ...(scoringModel ? ["scoring"] : []), ...(customFields.length ? ["details"] : [])];
  const requestedTab = initialTab === "ost" ? "tree" : initialTab;
  return (
    <div data-slot="opportunity-detail" data-variant={variant} className={`@container min-w-0 break-words pb-8 ${variant === "panel" ? "px-5" : ""}`}>
      <div className="flex min-w-0 flex-col gap-5">
        {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">Could not refresh opportunity. Showing the last loaded details.<Button variant="outline" size="sm" onClick={refresh}>Retry refresh</Button></div>}
        <OpportunityHeader opportunity={data} squads={data.squads ?? []} availableKeyResults={data.availableKeyResults ?? []} revalidatePathStr={detailPath} edit={edit} onChanged={refresh} />
        <div className="flex flex-wrap items-center gap-3">
          {scoringModel && <ScoreBadge score={toScoreSummary(data.score, scoringModel)} scoringHref={`${detailPath}?tab=scoring`} />}
          <Button variant="ghost" size="sm" aria-controls={discussionId} onClick={() => { discussionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); discussionRef.current?.focus({ preventScroll: true }); }}><MessageSquare className="size-4" /> Discussion</Button>
          <RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="OPPORTUNITY" subjectId={data.id} subjectTitle={data.title} />
          {data.pmInterviewEnabled && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="OPPORTUNITY" targetId={data.id} />}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-7 @[801px]:grid-cols-[minmax(0,1fr)_310px] @[801px]:gap-8">
          <div data-slot="opportunity-detail-main" className="flex min-w-0 flex-col gap-6">
            <Tabs defaultValue={requestedTab && availableTabs.includes(requestedTab) ? requestedTab : "solutions"}>
              <div className="max-w-full overflow-x-auto pb-1"><TabsList variant="line" aria-label="Opportunity sections">
                <TabsTrigger value="solutions">Solutions ({data.solutions.length})</TabsTrigger>
                <TabsTrigger value="evidence">Evidence ({data.evidence.length})</TabsTrigger>
                <TabsTrigger value="tree">OST</TabsTrigger>
                {scoringModel && <TabsTrigger value="scoring">Scoring</TabsTrigger>}
                {customFields.length > 0 && <TabsTrigger value="details">Details</TabsTrigger>}
              </TabsList></div>
              <TabsContent value="solutions" className="flex min-w-0 flex-col gap-3 pt-4">
                {!data.solutions.length && <p className="text-sm text-muted-foreground">No solutions yet. Add one below.</p>}
                <SolutionsList solutions={data.solutions} revalidatePathStr={detailPath} onChanged={refresh} />
                <AddSolutionForm opportunityId={data.id} revalidatePathStr={detailPath} onAdded={refresh} />
              </TabsContent>
              <TabsContent value="evidence" className="flex min-w-0 flex-col gap-3 pt-4">
                <AddEvidenceDialog workspaceId={data.workspaceId} nodeType="opportunity" nodeId={data.id} revalidatePathStr={detailPath} onMutated={refresh} />
                <EvidenceList evidence={data.evidence} revalidatePathStr={detailPath} orgSlug={orgSlug} workspaceSlug={workspaceSlug} onMutated={refresh} />
              </TabsContent>
              <TabsContent value="tree" className="min-w-0 overflow-x-auto pt-4"><OSTTreeView opportunity={data} orgSlug={orgSlug} workspaceSlug={workspaceSlug} /></TabsContent>
              {scoringModel && <TabsContent value="scoring" className="pt-4"><ScoringPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} opportunityId={data.id} revalidatePathStr={detailPath} scoringModel={scoringModel} existingScore={data.existingScore} onSaved={refresh} /></TabsContent>}
              {customFields.length > 0 && <TabsContent value="details" className="pt-4"><CustomFieldsPanel fields={customFields} objectId={data.id} revalidatePathStr={detailPath} onSaved={refresh} /></TabsContent>}
            </Tabs>
            <Section label="Delivery tasks" count={data.deliveryTasks.length}><LinkedTasksSection linkedType="OPPORTUNITY" linkedId={data.id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} revalidatePathStr={detailPath} tasks={data.deliveryTasks} linkableTasks={data.linkableTasks} members={data.members} onChanged={refresh} /></Section>
            <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={data.pmInterviews} />
            <LinkedFeedback feedback={data.feedback} />
          </div>
          <aside ref={discussionRef} id={discussionId} tabIndex={-1} aria-label="Opportunity discussion" data-slot="opportunity-detail-discussion" className="min-w-0 scroll-mt-5 border-t border-border-default pt-6 focus-visible:outline-2 focus-visible:outline-ring @[801px]:border-t-0 @[801px]:border-l @[801px]:pt-0 @[801px]:pl-6"><Discussion targetType="OPPORTUNITY" targetId={opportunityId} /></aside>
        </div>
      </div>
    </div>
  );
}
