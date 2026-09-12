"use client";
import { Discussion } from "@/components/comments/discussion";
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link";
import { PmInterviewHistory } from "@/components/research/pm-interview-history";

import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  Section,
  Field,
  EditableText,
  RelationList,
  type RelationItem,
  type EditContext,
} from "./panel-parts";

type AssumptionData = {
  id: string;
  pmInterviews: Array<{ id: string; disposition: string; generationState: string; createdAt: string }>;
  pmInterviewEnabled?: boolean;
  title: string;
  description: string | null;
  riskLevel: string;
  status: string;
  solution: {
    id: string;
    title: string;
    opportunity: { id: string; title: string } | null;
  } | null;
  experiments: Array<{ id: string; title: string; status: string; conclusion: string | null }>;
};

const STATUS: Record<string, { label: string; className: string }> = {
  UNTESTED: { label: "Untested", className: "bg-surface-inset text-text-secondary" },
  TESTING: { label: "Testing", className: "bg-blue-100 text-blue-700" },
  VALIDATED: { label: "Validated", className: "bg-green-100 text-green-700" },
  INVALIDATED: { label: "Invalidated", className: "bg-red-100 text-red-700" },
};

const STATUS_ORDER = ["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"] as const;

const RISK: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-green-100 text-green-700",
};

const EXP_STATUS: Record<string, string> = {
  DESIGNING: "bg-surface-inset text-text-secondary",
  RUNNING: "bg-blue-100 text-blue-700",
  COMPLETE: "bg-green-100 text-green-700",
  KILLED: "bg-red-100 text-red-700",
};

export function AssumptionPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate } = useEntityDetail<AssumptionData>(
    "assumption",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="assumption" />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "assumption",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as AssumptionData),
  };

  const solutionItems: RelationItem[] = data.solution
    ? [{ type: "solution", id: data.solution.id, title: data.solution.title }]
    : [];
  const experimentItems: RelationItem[] = data.experiments.map((e) => ({
    type: "experiment",
    id: e.id,
    title: e.title,
    badge: { label: e.status, className: EXP_STATUS[e.status] ?? "bg-surface-inset text-text-secondary" },
  }));

  return (
    <PanelContainer>
      {data.solution?.opportunity && (
        <FullPageLink
          href={`/${orgSlug}/${workspaceSlug}/discovery/${data.solution.opportunity.id}`}
        />
      )}

      <PanelTitle
        title={data.title}
        status={{ value: data.status, ...(STATUS[data.status] ?? { label: data.status }) }}
        edit={edit}
        statusEdit={{ field: "status", options: STATUS_ORDER, map: STATUS }}
      />
      {data.pmInterviewEnabled && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="ASSUMPTION" targetId={id} />}

      <Field label="Risk level">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${RISK[data.riskLevel] ?? "bg-surface-inset text-text-secondary"}`}
        >
          {data.riskLevel}
        </span>
      </Field>

      <EditableText value={data.description} field="description" edit={edit} multiline placeholder="Add a description…" />

      <Section label="Solution">
        <RelationList items={solutionItems} empty="No parent solution." />
      </Section>

      <Section label="Experiments" count={data.experiments.length}>
        <RelationList items={experimentItems} empty="No experiments yet." />
      </Section>
      <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={data.pmInterviews} />
      <Discussion targetType="ASSUMPTION" targetId={id} />
    </PanelContainer>
  );
}
