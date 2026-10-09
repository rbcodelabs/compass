"use client";
import { useState } from "react";
import { Discussion } from "@/components/comments/discussion";

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
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import type { MemberData } from "@/lib/types";
import { useLabels, useThinkingModel } from "@/components/thinking-model/thinking-model-provider";
import { LinkedSolutionsSection } from "./linked-solutions-section";
import { cycleRouteSegment, noCycleLabel } from "@/lib/okr-cycle-scope";
import { MeasurementsPanel } from "@/components/analytics/measurements-panel";
import { CheckInForm } from "@/components/okrs/check-in-form";
import { CheckInHistory, KrHero, KrSparkline } from "@/components/okrs/kr-progress-history";
import { cycleTiming } from "@/lib/okr-cycle-rollup";
import "@/components/okrs/okrs-gallery.css";

type KeyResultData = {
  id: string;
  title: string;
  current: number;
  target: number;
  unit: string | null;
  objective: { id: string; title: string; cycleId: string | null; cycle?: { startDate: string; endDate: string } | null } | null;
  checkIns: Array<{ id: string; value: number; note: string | null; createdAt: string }>;
  roadmapItems: Array<{ id: string; title: string; horizon: string; status: string }>;
  opportunities: Array<{ id: string; title: string; status: string }>;
  supportingObjectives: Array<{
    id: string;
    title: string;
    status: string;
    cycle: { id: string; title: string } | null;
    squad: { id: string; name: string; color: string } | null;
    keyResults: Array<{ current: number; target: number }>;
  }>;
  /** Typed Solution<->Key Result links (Phase 4B). Only sent for presets that offer the link. */
  linkedSolutions?: Array<{ id: string; title: string }>;
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
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
  const { data, error, mutate, refresh } = useEntityDetail<KeyResultData>(
    "keyResult",
    id,
    orgSlug,
    workspaceSlug
  );

  // Fixed at mount: the panel is client-fetched (never server-rendered), so there is no hydration drift,
  // and the sparkline/pace marker don't jitter between renders.
  const [now] = useState(() => Date.now());
  const labels = useLabels();
  const thinkingModel = useThinkingModel();
  const showLinkedSolutions = thinkingModel.links.solToKr !== "hidden";
  const cyclesSubdued = thinkingModel.cycles === "subdued";

  if (error) return <PanelError label={labels.keyResult.lower} />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "keyResult",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as KeyResultData),
  };

  const cycleDates = data.objective?.cycle ?? null;
  const timing = cycleDates ? cycleTiming(cycleDates.startDate, cycleDates.endDate, new Date(now)) : null;
  const elapsed = timing?.phase === "running" ? timing.percentElapsed : null;

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
    badge: { label: r.horizon, className: "bg-surface-inset text-text-secondary" },
  }));
  const supportingItems: RelationItem[] = data.supportingObjectives.map((objective) => {
    // Subdued cycles (Torres): name the cycle where there is one, never a "no cycle" placeholder.
    const cycleTitle = objective.cycle?.title ?? (cyclesSubdued ? null : noCycleLabel(labels.cycle));
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
        label: cycleTitle ? `${cycleTitle} · ${progress}%` : `${progress}%`,
        className: "bg-accent text-accent-foreground",
      },
    };
  });

  return (
    <PanelContainer>
      {data.objective && (
        <FullPageLink
          href={`/${orgSlug}/${workspaceSlug}/okrs/${cycleRouteSegment(data.objective.cycleId)}`}
        />
      )}

      <PanelTitle title={data.title} edit={edit} />
      <MeasurementsPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} target={{ targetType: "KEY_RESULT", targetId: data.id }} compact />

      <KrHero current={data.current} target={data.target} unit={data.unit} elapsed={elapsed}
            hideProgress={timing?.phase === "upcoming"} />

      <section className="okx-psec" aria-label="Check-ins">
        <h3 className="okx-psec-h">
          Check-ins <span>{data.checkIns.length}</span>
        </h3>
        <KrSparkline points={data.checkIns} target={data.target} cycle={cycleDates} now={now} />
        <CheckInHistory points={data.checkIns} unit={data.unit} />
        <div>
          <CheckInForm
            keyResultId={data.id}
            keyResultTitle={data.title}
            currentValue={data.current}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            onSaved={refresh}
          />
        </div>
      </section>

      <Section label={labels.objective.singular}>
        <RelationList items={objectiveItems} empty={`No parent ${labels.objective.lower}.`} />
      </Section>

      <Section label={`Supporting ${labels.objective.plural}`} count={data.supportingObjectives.length}>
        <RelationList items={supportingItems} empty={`No supporting ${labels.objective.plural} linked.`} />
      </Section>

      <Section label={`Linked ${labels.opportunity.plural}`} count={data.opportunities.length}>
        <RelationList items={oppItems} empty={`No ${labels.opportunity.lowerPlural} linked.`} />
      </Section>

      {/* Phase 4B: present only for presets that offer the Solution <-> Key Result link (the fetcher omits it for CLASSIC). */}
      {showLinkedSolutions && (
        <LinkedSolutionsSection solutions={data.linkedSolutions ?? []} />
      )}

      <Section label="Roadmap" count={data.roadmapItems.length}>
        <RelationList items={roadmapItems} empty="Not on the roadmap." />
      </Section>

      <Section label="Delivery tasks" count={data.deliveryTasks.length}>
        <LinkedTasksSection
          linkedType="KEY_RESULT"
          linkedId={data.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={data.objective ? `/${orgSlug}/${workspaceSlug}/okrs/${cycleRouteSegment(data.objective.cycleId)}` : `/${orgSlug}/${workspaceSlug}/okrs`}
          tasks={data.deliveryTasks}
          linkableTasks={data.linkableTasks}
          members={data.members}
          onChanged={refresh}
        />
      </Section>
      <Discussion targetType="KEY_RESULT" targetId={id} />
    </PanelContainer>
  );
}
