"use client";

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
  type RelationItem,
} from "./panel-parts";

type RoadmapItemData = {
  id: string;
  title: string;
  description: string | null;
  horizon: string;
  status: string;
  isPrivate: boolean;
  startDate: string | null;
  endDate: string | null;
  squad: { id: string; name: string; color: string } | null;
  solution: { id: string; title: string } | null;
  keyResult: { id: string; title: string } | null;
  opportunity: { id: string; title: string } | null;
  experiment: { id: string; title: string } | null;
  feedback: { id: string; title: string } | null;
  _count: { votes: number };
};

const HORIZON: Record<string, { label: string; className: string }> = {
  NOW: { label: "Now", className: "bg-indigo-100 text-indigo-700" },
  NEXT: { label: "Next", className: "bg-blue-100 text-blue-700" },
  LATER: { label: "Later", className: "bg-slate-100 text-slate-600" },
  SHIPPED: { label: "Shipped", className: "bg-green-100 text-green-700" },
};

export function RoadmapItemPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error } = useEntityDetail<RoadmapItemData>(
    "roadmapItem",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="roadmap item" />;
  if (!data) return <PanelSkeleton />;

  // The five possible origins collapse into one "linked" list.
  const linked: RelationItem[] = [];
  if (data.opportunity)
    linked.push({ type: "opportunity", id: data.opportunity.id, title: data.opportunity.title, badge: { label: "Opportunity", className: "bg-violet-100 text-violet-700" } });
  if (data.solution)
    linked.push({ type: "solution", id: data.solution.id, title: data.solution.title, badge: { label: "Solution", className: "bg-blue-100 text-blue-700" } });
  if (data.experiment)
    linked.push({ type: "experiment", id: data.experiment.id, title: data.experiment.title, badge: { label: "Experiment", className: "bg-amber-100 text-amber-700" } });
  if (data.keyResult)
    linked.push({ type: "keyResult", id: data.keyResult.id, title: data.keyResult.title, badge: { label: "Key Result", className: "bg-indigo-100 text-indigo-700" } });
  if (data.feedback)
    linked.push({ type: "feedback", id: data.feedback.id, title: data.feedback.title, badge: { label: "Feedback", className: "bg-slate-100 text-slate-600" } });

  return (
    <PanelContainer>
      <FullPageLink href={`/${orgSlug}/${workspaceSlug}/roadmap`} />

      <PanelTitle title={data.title} status={HORIZON[data.horizon] ?? { label: data.horizon }} />

      {data.description && (
        <p className="text-sm text-foreground/80 leading-relaxed">{data.description}</p>
      )}

      <div className="flex flex-col gap-3">
        <Field label="Status">{data.status}</Field>
        {data.squad && <Field label="Squad">{data.squad.name}</Field>}
        <Field label="Votes">{data._count.votes}</Field>
        {data.isPrivate && <Field label="Visibility">Private (hidden from public roadmap)</Field>}
      </div>

      <Section label="Linked to" count={linked.length}>
        <RelationList items={linked} empty="Not linked to any discovery item." />
      </Section>
    </PanelContainer>
  );
}
