"use client";

import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  Section,
  RelationList,
  type RelationItem,
  type EditContext,
} from "./panel-parts";

type KeyResultData = {
  id: string;
  title: string;
  current: number;
  target: number;
  unit: string | null;
  objective: { id: string; title: string; cycleId: string } | null;
  checkIns: Array<{ id: string; value: number; note: string | null; createdAt: string }>;
  roadmapItems: Array<{ id: string; title: string; horizon: string; status: string }>;
  opportunities: Array<{ id: string; title: string; status: string }>;
  supportingObjectives: Array<{
    id: string;
    title: string;
    status: string;
    cycle: { id: string; title: string };
    squad: { id: string; name: string; color: string } | null;
    keyResults: Array<{ current: number; target: number }>;
  }>;
};

export function KeyResultPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate } = useEntityDetail<KeyResultData>(
    "keyResult",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="key result" />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "keyResult",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as KeyResultData),
  };

  const pct = data.target > 0 ? Math.round((data.current / data.target) * 100) : null;

  const objectiveItems: RelationItem[] = data.objective
    ? [{ type: "objective", id: data.objective.id, title: data.objective.title }]
    : [];
  const oppItems: RelationItem[] = data.opportunities.map((o) => ({
    type: "opportunity",
    id: o.id,
    title: o.title,
  }));
  const roadmapItems: RelationItem[] = data.roadmapItems.map((r) => ({
    type: "roadmapItem",
    id: r.id,
    title: r.title,
    badge: { label: r.horizon, className: "bg-slate-100 text-slate-600" },
  }));
  const supportingItems: RelationItem[] = data.supportingObjectives.map((objective) => {
    const progress = objective.keyResults.length
      ? Math.round(
          objective.keyResults.reduce(
            (sum, kr) => sum + (kr.target > 0 ? Math.min(100, (kr.current / kr.target) * 100) : 0),
            0
          ) / objective.keyResults.length
        )
      : 0;
    return {
      type: "objective",
      id: objective.id,
      title: objective.title,
      badge: {
        label: `${objective.cycle.title} · ${progress}%`,
        className: "bg-accent text-accent-foreground",
      },
    };
  });

  return (
    <PanelContainer>
      {data.objective && (
        <FullPageLink
          href={`/${orgSlug}/${workspaceSlug}/okrs/${data.objective.cycleId}`}
        />
      )}

      <PanelTitle title={data.title} edit={edit} />

      {/* Progress */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${pct !== null ? Math.min(pct, 100) : 0}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {data.current}/{data.target}
            {data.unit ? ` ${data.unit}` : ""}
            {pct !== null ? ` · ${pct}%` : ""}
          </span>
        </div>
      </div>

      <Section label="Objective">
        <RelationList items={objectiveItems} empty="No parent objective." />
      </Section>

      <Section label="Supporting Objectives" count={data.supportingObjectives.length}>
        <RelationList items={supportingItems} empty="No supporting Objectives linked." />
      </Section>

      <Section label="Linked Opportunities" count={data.opportunities.length}>
        <RelationList items={oppItems} empty="No opportunities linked." />
      </Section>

      <Section label="Roadmap" count={data.roadmapItems.length}>
        <RelationList items={roadmapItems} empty="Not on the roadmap." />
      </Section>
    </PanelContainer>
  );
}
