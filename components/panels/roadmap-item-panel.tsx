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
  Field,
  RelationList,
  type RelationItem,
  type EditContext,
} from "./panel-parts";
import { HORIZON_META, SETTABLE_HORIZONS } from "@/lib/roadmap";
import { LaunchTierPicker } from "./launch-tier-picker";
import { LaunchChecklist, type LaunchChecklistItemData } from "./launch-checklist";
import { PositioningBriefRow } from "./positioning-brief-row";
import { RoadmapDeliveryTasks, type RoadmapDeliveryTaskData } from "./roadmap-delivery-tasks";
import type { MemberData } from "@/lib/types";
import { RequestDecisionLink } from "@/components/decisions/request-decision-link";

type RoadmapItemData = {
  id: string;
  workspaceId: string;
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
  launchChecklist: { id: string; tier: string; items: LaunchChecklistItemData[] } | null;
  positioningBrief: { id: string; title: string } | null;
  deliveryTasks: RoadmapDeliveryTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
  _count: { votes: number };
};

// Display map for the horizon badge — every horizon, including the launch
// ones (an item can currently be in LAUNCHING/LAUNCHED and must render).
const HORIZON: Record<string, { label: string; className: string }> = Object.fromEntries(
  Object.entries(HORIZON_META).map(([h, m]) => [h, { label: m.label, className: m.badgeClass }])
);

// The dropdown only offers horizons the generic single-field edit will accept
// — LAUNCHING is excluded (only setLaunchTier may enter it). Display of a
// current LAUNCHING value still works via the map above.
const HORIZON_ORDER = SETTABLE_HORIZONS;

export function RoadmapItemPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate, refresh } = useEntityDetail<RoadmapItemData>(
    "roadmapItem",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="roadmap item" />;
  if (!data) return <PanelSkeleton />;

  const roadmapPath = `/${orgSlug}/${workspaceSlug}/roadmap`;

  const edit: EditContext = {
    type: "roadmapItem",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as RoadmapItemData),
  };

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
    linked.push({ type: "feedback", id: data.feedback.id, title: data.feedback.title, badge: { label: "Feedback", className: "bg-surface-inset text-text-secondary" } });

  return (
    <PanelContainer>
      <FullPageLink href={`/${orgSlug}/${workspaceSlug}/roadmap`} />

      <PanelTitle
        title={data.title}
        status={{ value: data.horizon, ...(HORIZON[data.horizon] ?? { label: data.horizon }) }}
        edit={edit}
        statusEdit={{ field: "horizon", options: HORIZON_ORDER, map: HORIZON }}
      />
      <RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="ROADMAP_ITEM" subjectId={data.id} subjectTitle={data.title} />

      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      <div className="flex flex-col gap-3">
        <Field label="Status">{data.status}</Field>
        {data.squad && <Field label="Squad">{data.squad.name}</Field>}
        <Field label="Votes">{data._count.votes}</Field>
        {data.isPrivate && <Field label="Visibility">Private (hidden from public roadmap)</Field>}
      </div>


      <Section label="Launch">
        <div className="flex flex-col gap-4">
          {data.launchChecklist ? (
            <LaunchChecklist
              horizon={data.horizon}
              tier={data.launchChecklist.tier}
              items={data.launchChecklist.items}
              workspaceId={data.workspaceId}
              revalidatePathStr={roadmapPath}
            />
          ) : (
            <LaunchTierPicker
              itemId={id}
              workspaceId={data.workspaceId}
              revalidatePathStr={roadmapPath}
              onDone={refresh}
            />
          )}
          <PositioningBriefRow
            itemId={id}
            workspaceId={data.workspaceId}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            brief={data.positioningBrief}
          />
        </div>
      </Section>

      <Section label="Linked to" count={linked.length}>
        <RelationList items={linked} empty="Not linked to any discovery item." />
      </Section>

      <Section label="Delivery tasks" count={data.deliveryTasks.length}>
        <RoadmapDeliveryTasks
          roadmapItemId={id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          tasks={data.deliveryTasks}
          linkableTasks={data.linkableTasks}
          members={data.members}
          onChanged={refresh}
        />
      </Section>
    </PanelContainer>
  );
}
