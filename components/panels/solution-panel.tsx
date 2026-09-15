"use client";
import { Discussion } from "@/components/comments/discussion";

import { useState, useTransition } from "react";
import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  EditableText,
  Section,
  RelationList,
  type RelationItem,
  type EditContext,
} from "./panel-parts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import { EvidenceList, type EvidenceListItem } from "@/components/discovery/evidence-list";
import type { AssumptionItemData } from "@/components/discovery/assumption-item";
import { SolutionAssumptions } from "./solution-assumptions";
import { SolutionPlanDiscussion } from "./solution-plan-discussion";
import { SolutionArtifacts, type SolutionArtifact } from "./solution-artifacts";
import { promoteToRoadmap } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { requestBuildingInvestmentAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions";
import { useRouter } from "next/navigation";
import type { SolutionComment, Horizon, MemberData } from "@/lib/types";
import {
  SOLUTION_STATUS,
  SOLUTION_STATUS_ORDER,
  solutionStatusBadge,
} from "@/lib/solution-status";
import { RequestDecisionLink } from "@/components/decisions/request-decision-link";
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link";
import { PmInterviewHistory } from "@/components/research/pm-interview-history";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";

type SolutionData = {
  id: string;
  pmInterviews: Array<{ id: string; disposition: string; generationState: string; createdAt: string }>;
  pmInterviewEnabled?: boolean;
  title: string;
  description: string | null;
  status: string;
  opportunity: { id: string; title: string; workspaceId: string; squadId: string | null } | null;
  assumptions: AssumptionItemData[];
  evidence: EvidenceListItem[];
  comments: SolutionComment[];
  roadmapItems: Array<{ id: string; title: string; horizon: string }>;
  artifacts: SolutionArtifact[];
  availableArtifacts: SolutionArtifact[];
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
};

// Presentation lives in lib/solution-status.ts — see the note there on the
// three drifted copies this replaced (this one had SHIPPED and VALIDATED
// rendering the same green, and no dark-mode variants at all).
const STATUS = SOLUTION_STATUS;
const STATUS_ORDER = SOLUTION_STATUS_ORDER;

// Which sections a solution opens on first visit is a per-type editorial call,
// so it is declared here rather than inside Section: a solution is read
// top-down for what it is and what it assumes; evidence, roadmap, plan and
// artifacts are reference material you open when you want them. After a reader
// toggles a section, their stored preference wins over these defaults.
const SECTION = { collapsible: true, panelType: "solution" } as const;

export function SolutionPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate, refresh } = useEntityDetail<SolutionData>(
    "solution",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="solution" />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "solution",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as SolutionData),
  };

  const oppItems: RelationItem[] = data.opportunity
    ? [{ type: "opportunity", id: data.opportunity.id, title: data.opportunity.title }]
    : [];
  const roadmapItems: RelationItem[] = data.roadmapItems.map((r) => ({
    type: "roadmapItem",
    id: r.id,
    title: r.title,
    badge: { label: r.horizon, className: "bg-surface-inset text-text-secondary" },
  }));

  // Same fallback the old card used (revalidatePath just needs *a* path in
  // this workspace) — the opportunity should always be present in practice.
  const revalidatePathStr = data.opportunity
    ? `/${orgSlug}/${workspaceSlug}/discovery/${data.opportunity.id}`
    : `/${orgSlug}/${workspaceSlug}/discovery`;

  const canPromote = data.status === "VALIDATED" || data.status === "IN_DELIVERY";

  return (
    <PanelContainer>
      {data.opportunity && (
        <FullPageLink
          href={`/${orgSlug}/${workspaceSlug}/discovery/${data.opportunity.id}`}
        />
      )}

      <PanelTitle
        title={data.title}
        status={{ value: data.status, ...solutionStatusBadge(data.status) }}
        edit={edit}
        statusEdit={{ field: "status", options: STATUS_ORDER, map: STATUS }}
      />
      <RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="SOLUTION" subjectId={data.id} subjectTitle={data.title} />
      {data.pmInterviewEnabled && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="SOLUTION" targetId={id} />}

      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      <Section {...SECTION} defaultOpen label="Opportunity" empty={oppItems.length === 0}>
        <RelationList items={oppItems} empty="No parent opportunity." />
      </Section>

      <Section {...SECTION} defaultOpen label="Assumptions" count={data.assumptions.length}>
        {data.opportunity ? (
          <SolutionAssumptions
            // Remount when the assumption set actually changes (add/delete)
            // so the component's local reorder state re-seeds from fresh
            // server data instead of needing an effect to sync props in.
            key={data.assumptions.map((a) => a.id).join(",")}
            solutionId={data.id}
            workspaceId={data.opportunity.workspaceId}
            assumptions={data.assumptions}
            revalidatePathStr={revalidatePathStr}
            onChanged={refresh}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No assumptions yet.</p>
        )}
      </Section>

      {data.opportunity && (
        <Section {...SECTION} label="Evidence" count={data.evidence.length}>
          <div className="flex flex-col gap-2">
            <AddEvidenceDialog
              workspaceId={data.opportunity.workspaceId}
              nodeType="solution"
              nodeId={data.id}
              revalidatePathStr={revalidatePathStr}
              onMutated={refresh}
            />
            <EvidenceList evidence={data.evidence} revalidatePathStr={revalidatePathStr} />
          </div>
        </Section>
      )}

      <Section {...SECTION} label="Roadmap" count={data.roadmapItems.length}>
        <div className="flex flex-col gap-2">
          <RelationList items={roadmapItems} empty="Not on the roadmap." />
          {canPromote && data.opportunity && (
            <PromoteToRoadmap
              solutionId={data.id}
              workspaceId={data.opportunity.workspaceId}
              squadId={data.opportunity.squadId}
              opportunityId={data.opportunity.id}
              onDone={refresh}
            />
          )}
        </div>
      </Section>

      {data.opportunity && (
        <Section label="Investment decision">
          <BuildingInvestmentButton
            workspaceId={data.opportunity.workspaceId}
            solutionId={data.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </Section>
      )}

      <Section
        {...SECTION}
        label="Current Plan"
        count={data.comments.filter((comment) => comment.commentType === "PLAN").length}
      >
        <SolutionPlanDiscussion
          solutionId={data.id}
          comments={data.comments.filter((comment) => comment.commentType === "PLAN")}
          revalidatePathStr={revalidatePathStr}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onChanged={refresh}
        />
      </Section>

      {data.opportunity && (
        <Section {...SECTION} label="Artifacts" count={data.artifacts.length}>
          <SolutionArtifacts
            solutionId={data.id}
            workspaceId={data.opportunity.workspaceId}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            artifacts={data.artifacts}
            availableArtifacts={data.availableArtifacts}
            revalidatePathStr={revalidatePathStr}
            onChanged={refresh}
          />
        </Section>
      )}

      <Section {...SECTION} label="Delivery tasks" count={data.deliveryTasks.length}>
        <LinkedTasksSection
          linkedType="SOLUTION"
          linkedId={data.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={revalidatePathStr}
          tasks={data.deliveryTasks}
          linkableTasks={data.linkableTasks}
          members={data.members}
          onChanged={refresh}
        />
      </Section>
      <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={data.pmInterviews} />
      <Discussion targetType="SOLUTION" targetId={id} />
    </PanelContainer>
  );
}

function BuildingInvestmentButton({ workspaceId, solutionId, orgSlug, workspaceSlug }: { workspaceId: string; solutionId: string; orgSlug: string; workspaceSlug: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" disabled={isPending} onClick={() => startTransition(async () => {
        setError(null);
        try {
          const review = await requestBuildingInvestmentAction(workspaceId, solutionId);
          router.push(`/${orgSlug}/${workspaceSlug}/reviews/${review.requestId}`);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not prepare the investment review.");
        }
      })}>
        {isPending ? "Preparing review…" : "Request Building investment review"}
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function PromoteToRoadmap({
  solutionId,
  workspaceId,
  squadId,
  opportunityId,
  onDone,
}: {
  solutionId: string;
  workspaceId: string;
  squadId: string | null;
  opportunityId: string;
  onDone: () => void;
}) {
  const [promoting, setPromoting] = useState(false);
  const [horizon, setHorizon] = useState<Horizon>("NOW");
  const [isPending, startTransition] = useTransition();

  function handlePromote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      await promoteToRoadmap(solutionId, workspaceId, horizon, squadId, opportunityId);
      setPromoting(false);
      onDone();
    });
  }

  if (!promoting) {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground w-fit"
        onClick={() => setPromoting(true)}
      >
        → Promote to Roadmap
      </Button>
    );
  }

  return (
    <form onSubmit={handlePromote} className="flex items-center gap-2">
      <Select
        value={horizon}
        onValueChange={(v: string | null) => {
          if (v) setHorizon(v as Horizon);
        }}
        disabled={isPending}
      >
        <SelectTrigger size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="NOW">Now</SelectItem>
          <SelectItem value="NEXT">Next</SelectItem>
          <SelectItem value="LATER">Later</SelectItem>
          <SelectItem value="SHIPPED">Shipped</SelectItem>
        </SelectContent>
      </Select>
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Adding..." : "→ Roadmap"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() => setPromoting(false)}
      >
        Cancel
      </Button>
    </form>
  );
}
