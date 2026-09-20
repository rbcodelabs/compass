"use client";
import { Discussion } from "@/components/comments/discussion";
import { usePanelContext } from "./panel-context";
import { LinkedFeedback, type LinkedFeedbackItem } from "@/components/discovery/linked-feedback";

import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  Section,
  Field,
  RelationList,
  EditableText,
  type RelationItem,
  type EditContext,
} from "./panel-parts";
import { EvidenceList, type EvidenceListItem } from "@/components/discovery/evidence-list";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import { AddSolutionForm } from "@/components/discovery/add-solution-form";
import { solutionStatusBadge } from "@/lib/solution-status";
import { RequestDecisionLink } from "@/components/decisions/request-decision-link";
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link";
import { PmInterviewHistory } from "@/components/research/pm-interview-history";
import { ScoreBadge } from "@/components/discovery/score-badge";
import { toScoreSummary } from "@/lib/score-summary";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import type { MemberData } from "@/lib/types";

type OpportunityData = {
  id: string;
  title: string;
  status: string;
  description: string | null;
  customerSegment: string | null;
  workspaceId: string;
  pmInterviews: Array<{ id: string; disposition: string; generationState: string; createdAt: string }>;
  pmInterviewEnabled?: boolean;
  linkedKeyResult: {
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
    objective: { title: string; cycleId: string } | null;
  } | null;
  solutions: Array<{ id: string; title: string; status: string }>;
  evidence: EvidenceListItem[];
  feedback: LinkedFeedbackItem[];
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
  /** Null when this opportunity has never been scored. */
  score: { normalizedScore: number; modelVersion: number } | null;
  /** Null when the workspace has no active scoring model — render no score UI. */
  workspace: {
    scoringConfig: { scoringModel: { id: string; name: string; version: number } | null } | null;
  } | null;
};

// Matches the actual Opportunity status enum (see lib/entity-mutations.ts /
// opportunity-card). The panel previously carried a stale set (VALIDATED /
// DEPRIORITIZED) that never matched real data.
const STATUS_MAP: Record<string, { label: string; className: string }> = {
  EXPLORING: { label: "Exploring", className: "bg-violet-100 text-violet-700" },
  VALIDATING: { label: "Validating", className: "bg-blue-100 text-blue-700" },
  PRIORITIZED: { label: "Prioritized", className: "bg-indigo-100 text-indigo-700" },
  ACTIVE: { label: "Active", className: "bg-green-100 text-green-700" },
  ARCHIVED: { label: "Archived", className: "bg-surface-inset text-text-subtle" },
};
const STATUS_ORDER = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"] as const;

export function OpportunityPanel({
  opportunityId,
  orgSlug,
  workspaceSlug,
}: {
  opportunityId: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { openPanel } = usePanelContext();
  const { data, error, mutate, refresh } = useEntityDetail<OpportunityData>(
    "opportunity",
    opportunityId,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="opportunity" />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "opportunity",
    id: opportunityId,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as OpportunityData),
  };

  const fullPageHref = `/${orgSlug}/${workspaceSlug}/discovery/${opportunityId}`;

  // Same gate and the same staleness derivation as the Discovery board — see
  // lib/score-summary.ts. No active model means no score UI anywhere.
  const activeScoringModel = data.workspace?.scoringConfig?.scoringModel ?? null;
  const scoreSummary = toScoreSummary(data.score, activeScoringModel);

  const krProgress =
    data.linkedKeyResult && data.linkedKeyResult.target > 0
      ? Math.round((data.linkedKeyResult.current / data.linkedKeyResult.target) * 100)
      : null;

  // Solutions were previously plain <p> text — a dead end, since every other
  // relation in every other panel opens that entity's own panel. RelationList
  // makes the opportunity → solution hop work the same as solution →
  // opportunity already did.
  const solutionItems: RelationItem[] = data.solutions.map((sol) => ({
    type: "solution",
    id: sol.id,
    title: sol.title,
    badge: solutionStatusBadge(sol.status),
  }));

  return (
    <PanelContainer>
      <FullPageLink href={fullPageHref} />

      <PanelTitle
        title={data.title}
        status={{ value: data.status, ...(STATUS_MAP[data.status] ?? { label: data.status }) }}
        edit={edit}
        statusEdit={{ field: "status", options: STATUS_ORDER, map: STATUS_MAP }}
      />
      <RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="OPPORTUNITY" subjectId={data.id} subjectTitle={data.title} />
      {data.pmInterviewEnabled && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="OPPORTUNITY" targetId={opportunityId} />}

      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      {data.customerSegment && (
        <Field label="Customer Segment">{data.customerSegment}</Field>
      )}

      {activeScoringModel && (
        <Field label="Score">
          <ScoreBadge score={scoreSummary} scoringHref={`${fullPageHref}?tab=scoring`} />
        </Field>
      )}

      <Section label="Driving Key Result">
        {data.linkedKeyResult ? (
          <div className="flex flex-col gap-1.5">
            {data.linkedKeyResult.objective && (
              <p className="text-xs text-muted-foreground">
                {data.linkedKeyResult.objective.title}
              </p>
            )}
            <button
              type="button"
              onClick={() => openPanel("keyResult", data.linkedKeyResult!.id)}
              className="text-left text-sm font-medium leading-snug underline underline-offset-2 rounded-sm focus-visible:outline-2 focus-visible:outline-ring break-words"
            >
              {data.linkedKeyResult.title}
            </button>
            {krProgress !== null && (
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.min(krProgress, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {data.linkedKeyResult.current}/{data.linkedKeyResult.target}
                  {data.linkedKeyResult.unit ? ` ${data.linkedKeyResult.unit}` : ""}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No key result linked.</p>
        )}
      </Section>

      <LinkedFeedback feedback={data.feedback} />

      <Section label="Solutions" count={data.solutions.length}>
        <div className="flex flex-col gap-2">
          <RelationList items={solutionItems} empty="No solutions yet." />
          {/* onAdded={refresh}: the panel owns its data client-side, so
              revalidatePath alone would leave the list stale until reopened. */}
          <AddSolutionForm
            opportunityId={data.id}
            revalidatePathStr={fullPageHref}
            onAdded={refresh}
          />
        </div>
      </Section>

      <Section label="Evidence" count={data.evidence.length}>
        <div className="flex flex-col gap-2">
          <AddEvidenceDialog
            workspaceId={data.workspaceId}
            nodeType="opportunity"
            nodeId={data.id}
            revalidatePathStr={fullPageHref}
            onMutated={refresh}
          />
          <EvidenceList
            evidence={data.evidence}
            revalidatePathStr={fullPageHref}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </div>
      </Section>

      <Section label="Delivery tasks" count={data.deliveryTasks.length}>
        <LinkedTasksSection
          linkedType="OPPORTUNITY"
          linkedId={data.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={fullPageHref}
          tasks={data.deliveryTasks}
          linkableTasks={data.linkableTasks}
          members={data.members}
          onChanged={refresh}
        />
      </Section>
      <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={data.pmInterviews} />
      <Discussion targetType="OPPORTUNITY" targetId={opportunityId} />
    </PanelContainer>
  );
}
