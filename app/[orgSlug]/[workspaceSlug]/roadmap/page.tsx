import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { RoadmapBoard } from "@/components/roadmap/roadmap-board";
import { NativeTimeline } from "@/components/roadmap/native-timeline/native-timeline";
import { RoadmapHeader } from "@/components/roadmap/roadmap-header";
import type { Horizon, SquadData, TaskStatus } from "@/lib/types";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";
import type { UnscheduledItem } from "@/components/roadmap/unscheduled-items-panel";
import { deriveRoadmapDeliveryStatus } from "@/lib/roadmap-delivery-status";
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions";
import {
  buildCustomFieldFilterGroups,
  parseCustomFieldFilterParams,
  resolveCustomFieldFilter,
} from "@/lib/custom-field-filter";
import { roadmapBoardFilterKey } from "@/lib/roadmap-filters";
import { parseGroupByParam, resolveRoadmapGroupBy } from "@/lib/roadmap-group-by";
import { loadCustomFieldValuesForObjects } from "@/lib/custom-field-values-batch";

export const metadata = {
  title: "Roadmap",
};

interface RoadmapPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ squad?: string; view?: string; field?: string; fieldValue?: string; groupBy?: string }>;
}

export default async function RoadmapPage({ params, searchParams }: RoadmapPageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const {
    squad: squadFilter,
    view: viewParam,
    field: fieldParam,
    fieldValue: fieldValueParam,
    groupBy: groupByParam,
  } = await searchParams;
  const view = viewParam === "timeline" ? "timeline" : "board";
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
  });

  if (!workspace) notFound();

  const [roadmapFieldDefs, customFieldFilter] = await Promise.all([
    loadCustomFieldDefinitions(prisma, {
      workspaceId: workspace.id,
      objectTypes: ["ROADMAP_ITEM"],
    }),
    resolveCustomFieldFilter(prisma, {
      workspaceId: workspace.id,
      objectTypes: ["ROADMAP_ITEM"],
      filter: parseCustomFieldFilterParams({ field: fieldParam, fieldValue: fieldValueParam }),
    }),
  ]);
  const customFieldGroups = buildCustomFieldFilterGroups(roadmapFieldDefs);
  // Only SELECT-type fields are groupable — MULTI_SELECT is out of scope
  // (an item could belong to more than one group, which breaks
  // one-row-per-item lane packing on the timeline).
  const resolvedGroupBy = resolveRoadmapGroupBy(parseGroupByParam(groupByParam), roadmapFieldDefs);
  const groupByOptions = roadmapFieldDefs
    .filter((field) => field.fieldType === "SELECT")
    .map((field) => ({ id: field.id, label: field.name }));

  const [rawSquads, items, rawKRs, rawSolutions, rawOpportunities, rawExperiments, unscheduledSolutions, unscheduledBugs] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.roadmapItem.findMany({
      where: {
        workspaceId: workspace.id,
        status: "ACTIVE",
        ...(squadFilter ? { squadId: squadFilter } : {}),
        ...(customFieldFilter ? { id: { in: customFieldFilter.objectIds } } : {}),
      },
      orderBy: [{ horizon: "asc" }, { sortOrder: "asc" }],
      include: {
        solution: {
          select: { id: true, title: true },
        },
        keyResult: {
          select: {
            id: true,
            title: true,
            current: true,
            target: true,
            unit: true,
            objective: { select: { cycleId: true } },
          },
        },
        opportunity: {
          select: { id: true, title: true },
        },
        experiment: {
          select: { id: true, title: true },
        },
        feedback: {
          select: { id: true, title: true, type: true },
        },
        squad: {
          select: { id: true, name: true, color: true },
        },
        launchChecklist: {
          select: { tier: true, items: { select: { status: true } } },
        },
      },
    }),
    prisma.keyResult.findMany({
      where: { objective: { cycle: { workspaceId: workspace.id } } },
      select: {
        id: true,
        title: true,
        objective: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.solution.findMany({
      where: { opportunity: { workspaceId: workspace.id } },
      select: {
        id: true,
        title: true,
        opportunity: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.opportunity.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
      select: { id: true, title: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.experiment.findMany({
      where: { workspaceId: workspace.id, status: { not: "KILLED" } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
    // Validated/in-delivery Solutions with no ACTIVE RoadmapItem yet — the
    // same "ready to promote" condition as the Discovery solution card's
    // own Promote-to-Roadmap button, just surfaced on the roadmap itself.
    prisma.solution.findMany({
      where: {
        opportunity: { workspaceId: workspace.id },
        status: { in: ["VALIDATED", "IN_DELIVERY"] },
        roadmapItems: { none: { status: "ACTIVE" } },
      },
      select: {
        id: true,
        title: true,
        opportunityId: true,
        opportunity: { select: { title: true, squadId: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    // Bug-type feedback with no ACTIVE RoadmapItem yet. Ideas are excluded —
    // they're expected to go through Opportunity -> Solution discovery
    // first, same distinction the Feedback board already makes.
    prisma.feedbackItem.findMany({
      where: {
        workspaceId: workspace.id,
        type: "BUG",
        roadmapItems: { none: { status: "ACTIVE" } },
      },
      select: { id: true, title: true },
      orderBy: { voteCount: "desc" },
    }),
  ]);

  const customFieldValuesByItemId = resolvedGroupBy.mode === "customField"
    ? Object.fromEntries(
        (await loadCustomFieldValuesForObjects(prisma, {
          fieldId: resolvedGroupBy.field.id,
          objectIds: items.map((item) => item.id),
        })).entries(),
      )
    : undefined;

  const taskLinks = items.length === 0
    ? []
    : await prisma.taskLink.findMany({
        where: {
          linkedType: "ROADMAP_ITEM",
          linkedId: { in: items.map((item) => item.id) },
          task: { workspaceId: workspace.id },
        },
        select: { linkedId: true, task: { select: { status: true } } },
      });
  const taskStatusesByRoadmapItem = new Map<string, TaskStatus[]>();
  for (const link of taskLinks) {
    const statuses = taskStatusesByRoadmapItem.get(link.linkedId) ?? [];
    statuses.push(link.task.status as TaskStatus);
    taskStatusesByRoadmapItem.set(link.linkedId, statuses);
  }

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const availableKRs = rawKRs.map((kr) => ({
    id: kr.id,
    title: kr.title,
    objectiveTitle: kr.objective.title,
  }));

  const availableSolutions = rawSolutions.map((sol) => ({
    id: sol.id,
    title: sol.title,
    opportunityTitle: sol.opportunity.title,
  }));

  const availableExperiments = rawExperiments.map((exp) => ({
    id: exp.id,
    title: exp.title,
    status: exp.status,
  }));

  const cardItems: RoadmapCardData[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description ?? null,
    horizon: item.horizon as Horizon,
    sortOrder: item.sortOrder,
    isPrivate: item.isPrivate,
    solutionId: item.solutionId ?? null,
    keyResultId: item.keyResultId ?? null,
    opportunityId: item.opportunityId ?? null,
    experimentId: item.experimentId ?? null,
    feedbackId: item.feedbackId ?? null,
    startDate: item.startDate ? item.startDate.toISOString() : null,
    endDate: item.endDate ? item.endDate.toISOString() : null,
    updatedAt: item.updatedAt.toISOString(),
    solution: item.solution ?? null,
    keyResult: item.keyResult
      ? {
          id: item.keyResult.id,
          title: item.keyResult.title,
          current: item.keyResult.current,
          target: item.keyResult.target,
          unit: item.keyResult.unit,
          cycleId: item.keyResult.objective?.cycleId ?? null,
        }
      : null,
    opportunity: item.opportunity ?? null,
    experiment: item.experiment ?? null,
    feedback: item.feedback ?? null,
    squad: item.squad ?? null,
    launchChecklist: item.launchChecklist
      ? {
          tier: item.launchChecklist.tier,
          done: item.launchChecklist.items.filter((i) => i.status === "DONE").length,
          total: item.launchChecklist.items.length,
        }
      : null,
    deliveryStatus: deriveRoadmapDeliveryStatus(taskStatusesByRoadmapItem.get(item.id) ?? []),
  }));

  // A filter change is a new dataset; ordinary refreshes must preserve
  // in-flight mutation fences and optimistic edits. Both views seed their own
  // client state once, so both need this — the Board shipped without it and
  // went on painting pre-filter columns while the URL said otherwise.
  const filterKey = roadmapBoardFilterKey({
    workspaceId: workspace.id,
    squad: squadFilter,
    field: customFieldFilter?.fieldId ?? null,
    fieldValue: fieldValueParam,
  });

  const unscheduledItems: UnscheduledItem[] = [
    ...unscheduledSolutions.map((sol) => ({
      kind: "solution" as const,
      id: sol.id,
      title: sol.title,
      opportunityId: sol.opportunityId,
      opportunityTitle: sol.opportunity.title,
      squadId: sol.opportunity.squadId ?? null,
    })),
    ...unscheduledBugs.map((fb) => ({
      kind: "feedback" as const,
      id: fb.id,
      title: fb.title,
    })),
  ];

  return (
    <>
      {view === "timeline" ? (
        <Suspense>
          <NativeTimeline
            key={filterKey}
            items={cardItems}
            squads={squadFilter ? squads.filter((squad) => squad.id === squadFilter) : squads}
            headerSquads={squads}
            customFieldGroups={customFieldGroups}
            activeCustomFieldId={customFieldFilter?.fieldId ?? null}
            workspaceId={workspace.id}
            unscheduledItems={unscheduledItems}
            groupBy={resolvedGroupBy.mode}
            groupByField={resolvedGroupBy.mode === "customField" ? { id: resolvedGroupBy.field.id, name: resolvedGroupBy.field.name, options: resolvedGroupBy.field.options ?? [] } : undefined}
            customFieldValuesByItemId={customFieldValuesByItemId}
            groupByOptions={groupByOptions}
            launchWorkflowEnabled={workspace.launchWorkflowEnabled ?? false}
          />
        </Suspense>
      ) : (
        <div className="flex min-h-full min-w-0 flex-1 flex-col md:h-full md:min-h-0">
          <Suspense>
            <RoadmapHeader
              squads={squads}
              customFieldGroups={customFieldGroups}
              activeCustomFieldId={customFieldFilter?.fieldId ?? null}
            />
          </Suspense>
          <div data-slot="workspace-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
            <RoadmapBoard
              key={filterKey}
              initialItems={cardItems}
              workspaceId={workspace.id}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              availableKRs={availableKRs}
              availableSolutions={availableSolutions}
              availableOpportunities={rawOpportunities}
              availableExperiments={availableExperiments}
              unscheduledItems={unscheduledItems}
              squads={squads}
              nowLimit={workspace.nowLimit}
              nextLimit={workspace.nextLimit}
              launchWorkflowEnabled={workspace.launchWorkflowEnabled ?? false}
            />
          </div>
        </div>
      )}
    </>
  );
}
