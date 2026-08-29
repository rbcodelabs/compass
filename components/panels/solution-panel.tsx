"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { linkArtifact, unlinkArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

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
  artifacts: Array<{ id: string; title: string; sourceType: string }>;
  availableArtifacts: Array<{ id: string; title: string; sourceType: string }>;
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
  const [artifactId, setArtifactId] = useState("");
  const [pending, startTransition] = useTransition();

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

      <Section label="Artifacts" count={data.artifacts.length}>
        <div className="space-y-2">
          {data.artifacts.length === 0 ? <p className="text-sm text-muted-foreground">No linked artifacts.</p> : data.artifacts.map((artifact) => <div key={artifact.id} className="flex items-center justify-between gap-2 text-sm"><Link className="text-indigo-600 hover:underline" href={`/${orgSlug}/${workspaceSlug}/docs/artifacts/${artifact.id}`}>{artifact.title}</Link><Button size="xs" variant="ghost" disabled={pending} onClick={() => startTransition(async () => { await unlinkArtifact(data.opportunity!.workspaceId, artifact.id, data.id, `/${orgSlug}/${workspaceSlug}/discovery`); mutate({ ...data, artifacts: data.artifacts.filter((item) => item.id !== artifact.id) }) })}>Unlink</Button></div>)}
          {data.availableArtifacts.some((artifact) => !data.artifacts.some((linked) => linked.id === artifact.id)) && <div className="flex gap-2"><select aria-label="Artifact to link" className="h-8 flex-1 rounded border px-2 text-sm" value={artifactId} onChange={(event) => setArtifactId(event.target.value)}><option value="">Select artifact…</option>{data.availableArtifacts.filter((artifact) => !data.artifacts.some((linked) => linked.id === artifact.id)).map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</select><Button size="sm" disabled={!artifactId || pending} onClick={() => startTransition(async () => { const artifact = data.availableArtifacts.find((item) => item.id === artifactId); if (!artifact) return; await linkArtifact(data.opportunity!.workspaceId, artifact.id, data.id, `/${orgSlug}/${workspaceSlug}/discovery`); mutate({ ...data, artifacts: [...data.artifacts, artifact] }); setArtifactId("") })}>Link</Button></div>}
        </div>
      </Section>
    </PanelContainer>
  );
}
