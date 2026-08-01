"use client";

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

type SolutionData = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  opportunity: { id: string; title: string; workspaceId: string } | null;
  assumptions: Array<{ id: string; title: string; riskLevel: string; status: string }>;
  roadmapItems: Array<{ id: string; title: string; horizon: string }>;
};

const STATUS: Record<string, { label: string; className: string }> = {
  IDEA: { label: "Idea", className: "bg-slate-100 text-slate-600" },
  VALIDATED: { label: "Validated", className: "bg-green-100 text-green-700" },
  IN_DELIVERY: { label: "In delivery", className: "bg-blue-100 text-blue-700" },
  SHIPPED: { label: "Shipped", className: "bg-green-100 text-green-700" },
  KILLED: { label: "Killed", className: "bg-red-100 text-red-700" },
  SELECTED: { label: "Selected", className: "bg-blue-100 text-blue-700" },
};

const STATUS_ORDER = ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"] as const;

const RISK: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-green-100 text-green-700",
};

export function SolutionPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate } = useEntityDetail<SolutionData>(
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
  const assumptionItems: RelationItem[] = data.assumptions.map((a) => ({
    type: "assumption",
    id: a.id,
    title: a.title,
    badge: { label: a.riskLevel, className: RISK[a.riskLevel] ?? "bg-slate-100 text-slate-600" },
  }));
  const roadmapItems: RelationItem[] = data.roadmapItems.map((r) => ({
    type: "roadmapItem",
    id: r.id,
    title: r.title,
    badge: { label: r.horizon, className: "bg-slate-100 text-slate-600" },
  }));

  return (
    <PanelContainer>
      {data.opportunity && (
        <FullPageLink
          href={`/${orgSlug}/${workspaceSlug}/discovery/${data.opportunity.id}`}
        />
      )}

      <PanelTitle
        title={data.title}
        status={{ value: data.status, ...(STATUS[data.status] ?? { label: data.status }) }}
        edit={edit}
        statusEdit={{ field: "status", options: STATUS_ORDER, map: STATUS }}
      />

      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      <Section label="Opportunity">
        <RelationList items={oppItems} empty="No parent opportunity." />
      </Section>

      <Section label="Assumptions" count={data.assumptions.length}>
        <RelationList items={assumptionItems} empty="No assumptions yet." />
      </Section>

      <Section label="Roadmap" count={data.roadmapItems.length}>
        <RelationList items={roadmapItems} empty="Not on the roadmap." />
      </Section>
    </PanelContainer>
  );
}
