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

type ObjectiveData = {
  id: string;
  title: string;
  description: string | null;
  owner: string | null;
  status: string;
  cycle: { id: string; title: string } | null;
  squad: { id: string; name: string; color: string } | null;
  keyResults: Array<{
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
  }>;
};

const STATUS: Record<string, { label: string; className: string }> = {
  ON_TRACK: { label: "On track", className: "bg-green-100 text-green-700" },
  AT_RISK: { label: "At risk", className: "bg-amber-100 text-amber-700" },
  OFF_TRACK: { label: "Off track", className: "bg-red-100 text-red-700" },
  COMPLETE: { label: "Complete", className: "bg-blue-100 text-blue-700" },
};

export function ObjectivePanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error } = useEntityDetail<ObjectiveData>(
    "objective",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="objective" />;
  if (!data) return <PanelSkeleton />;

  const krItems: RelationItem[] = data.keyResults.map((kr) => {
    const pct = kr.target > 0 ? Math.round((kr.current / kr.target) * 100) : null;
    return {
      type: "keyResult",
      id: kr.id,
      title: kr.title,
      badge: pct !== null ? { label: `${pct}%`, className: "bg-indigo-100 text-indigo-700" } : undefined,
    };
  });

  return (
    <PanelContainer>
      {data.cycle && (
        <FullPageLink href={`/${orgSlug}/${workspaceSlug}/okrs/${data.cycle.id}`} />
      )}

      <PanelTitle title={data.title} status={STATUS[data.status] ?? { label: data.status }} />

      {data.description && (
        <p className="text-sm text-foreground/80 leading-relaxed">{data.description}</p>
      )}

      {(data.owner || data.squad || data.cycle) && (
        <div className="flex flex-col gap-3">
          {data.owner && <Field label="Owner">{data.owner}</Field>}
          {data.squad && <Field label="Squad">{data.squad.name}</Field>}
          {data.cycle && <Field label="Cycle">{data.cycle.title}</Field>}
        </div>
      )}

      <Section label="Key Results" count={data.keyResults.length}>
        <RelationList items={krItems} empty="No key results yet." />
      </Section>
    </PanelContainer>
  );
}
