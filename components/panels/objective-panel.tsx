"use client";
import { Discussion } from "@/components/comments/discussion";

import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  EditableText,
  Section,
  Field,
  RelationList,
  type RelationItem,
  type EditContext,
} from "./panel-parts";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import type { MemberData } from "@/lib/types";
import { useLabels, useThinkingModel } from "@/components/thinking-model/thinking-model-provider";
import { cycleRouteSegment, noCycleLabel } from "@/lib/okr-cycle-scope";

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
  parentKeyResult: {
    id: string;
    title: string;
    objective: {
      id: string;
      title: string;
      cycle: { id: string; title: string; status: string } | null;
    };
  } | null;
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
};

const STATUS: Record<string, { label: string; className: string }> = {
  ON_TRACK: { label: "On track", className: "bg-green-100 text-green-700" },
  AT_RISK: { label: "At risk", className: "bg-amber-100 text-amber-700" },
  OFF_TRACK: { label: "Off track", className: "bg-red-100 text-red-700" },
  COMPLETE: { label: "Complete", className: "bg-blue-100 text-blue-700" },
};

const STATUS_ORDER = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"] as const;

export function ObjectivePanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate, refresh } = useEntityDetail<ObjectiveData>(
    "objective",
    id,
    orgSlug,
    workspaceSlug
  );

  const labels = useLabels();
  // Cycles are subdued under Torres: shown where the Outcome has one, never as a "no cycle" placeholder.
  const showCycleField = useThinkingModel().cycles !== "subdued";

  if (error) return <PanelError label={labels.objective.lower} />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "objective",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as ObjectiveData),
  };

  const krItems: RelationItem[] = data.keyResults.map((kr) => {
    const pct = kr.target > 0 ? Math.round((kr.current / kr.target) * 100) : null;
    return {
      type: "keyResult",
      id: kr.id,
      title: kr.title,
      badge: pct !== null ? { label: `${pct}%`, className: "bg-primary/10 text-primary" } : undefined,
    };
  });
  const parentCycleTitle = data.parentKeyResult
    ? (data.parentKeyResult.objective.cycle?.title ?? (showCycleField ? noCycleLabel(labels.cycle) : null))
    : null;
  const parentItems: RelationItem[] = data.parentKeyResult
    ? [{
        type: "keyResult",
        id: data.parentKeyResult.id,
        title: data.parentKeyResult.title,
        ...(parentCycleTitle ? { badge: { label: parentCycleTitle, className: "bg-accent text-accent-foreground" } } : {}),
      }]
    : [];

  return (
    <PanelContainer>
      <FullPageLink href={`/${orgSlug}/${workspaceSlug}/okrs/${cycleRouteSegment(data.cycle?.id)}`} />

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

      <div className="flex flex-col gap-3">
        {data.owner && <Field label="Owner">{data.owner}</Field>}
        {data.squad && <Field label="Squad">{data.squad.name}</Field>}
        {(data.cycle || showCycleField) && <Field label={labels.cycle.singular}>{data.cycle?.title ?? noCycleLabel(labels.cycle)}</Field>}
      </div>

      <Section label={labels.keyResult.plural} count={data.keyResults.length}>
        <RelationList items={krItems} empty={`No ${labels.keyResult.lowerPlural} yet.`} />
      </Section>

      <Section label="Supports">
        <RelationList items={parentItems} empty={`No higher-level ${labels.keyResult.singular}.`} />
      </Section>

      <Section label="Delivery tasks" count={data.deliveryTasks.length}>
        <LinkedTasksSection
          linkedType="OBJECTIVE"
          linkedId={data.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={`/${orgSlug}/${workspaceSlug}/okrs/${cycleRouteSegment(data.cycle?.id)}`}
          tasks={data.deliveryTasks}
          linkableTasks={data.linkableTasks}
          members={data.members}
          onChanged={refresh}
        />
      </Section>
      <Discussion targetType="OBJECTIVE" targetId={id} />
    </PanelContainer>
  );
}
