import { Suspense } from "react";
import { cookies } from "next/headers";
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
import { ROADMAP_CARD_INCLUDE, toRoadmapCardData } from "@/lib/roadmap/card-data";
import { READY_STATUSES, type ScheduleCatalog } from "@/lib/roadmap/rail";
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions";
import {
  buildCustomFieldFilterGroups,
  parseCustomFieldFilterParams,
  resolveCustomFieldFilter,
} from "@/lib/custom-field-filter";
import { objectTypeLabels } from "@/components/custom-fields/object-type-labels";
import { resolveThinkingModel } from "@/lib/thinking-model/resolve";
import { roadmapBoardFilterKey } from "@/lib/roadmap-filters";
import { parseGroupByParam, resolveRoadmapGroupBy } from "@/lib/roadmap-group-by";
import { loadCustomFieldValuesForObjects } from "@/lib/custom-field-values-batch";
import { RAIL_COOKIE_NAME, parseRailPreference } from "@/lib/roadmap/rail-state";

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
  // Read on the server so a saved open/closed choice is in the first paint, not applied after hydration.
  const initialRailPreference = parseRailPreference((await cookies()).get(RAIL_COOKIE_NAME)?.value);
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
  const { labels } = resolveThinkingModel(workspace);
  const cardSortHref = `/${orgSlug}/${workspaceSlug}/card-sort?objectType=ROADMAP_ITEM`;
  const customFieldGroups = buildCustomFieldFilterGroups(roadmapFieldDefs, objectTypeLabels(labels));
  // Only SELECT-type fields are groupable — MULTI_SELECT is out of scope
  // (an item could belong to more than one group, which breaks
  // one-row-per-item lane packing on the timeline).
  const resolvedGroupBy = resolveRoadmapGroupBy(parseGroupByParam(groupByParam), roadmapFieldDefs);
  const groupByOptions = roadmapFieldDefs
    .filter((field) => field.fieldType === "SELECT")
    .map((field) => ({ id: field.id, label: field.name }));

  const [rawSquads, items, rawKRs, rawSolutions, rawOpportunities, rawExperiments, catalogSolutions, unscheduledBugs, activeItemCount] = await Promise.all([
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
      include: ROADMAP_CARD_INCLUDE,
    }),
    prisma.keyResult.findMany({
      where: { objective: { workspaceId: workspace.id } },
      select: {
        id: true,
        title: true,
        objective: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.solution.findMany({
      where: { workspaceId: workspace.id },
      select: {
        id: true,
        title: true,
        opportunity: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.opportunity.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
      select: { id: true, title: true, squadId: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.experiment.findMany({
      where: { workspaceId: workspace.id, status: { not: "KILLED" } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
    // Every live Discovery solution, flagged by whether it already has an ACTIVE
    // RoadmapItem. This one read feeds the "Ready to schedule" rail (validated and
    // in-delivery solutions with no item yet, the same "ready to promote" condition
    // as the Discovery solution card), the schedule palette and the empty-roadmap
    // presets. It is deliberately not narrowed by the view filters: a solution
    // scheduled under another squad is still scheduled.
    prisma.solution.findMany({
      where: { workspaceId: workspace.id, status: { not: "KILLED" } },
      select: {
        id: true,
        title: true,
        status: true,
        opportunityId: true,
        opportunity: { select: { title: true, squadId: true } },
        score: { select: { normalizedScore: true } },
        roadmapItems: { where: { status: "ACTIVE" }, select: { id: true }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
      take: 500,
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
    // Unfiltered: the empty-roadmap prompt must not appear just because a filter hid every item.
    prisma.roadmapItem.count({ where: { workspaceId: workspace.id, status: "ACTIVE" } }),
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

  const cardItems: RoadmapCardData[] = items.map((item) => toRoadmapCardData(item, taskStatusesByRoadmapItem.get(item.id) ?? []));

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

  const scheduleCatalog: ScheduleCatalog = {
    solutions: catalogSolutions.map((sol) => ({
      id: sol.id,
      title: sol.title,
      status: sol.status,
      score: sol.score?.normalizedScore ?? null,
      opportunityId: sol.opportunityId,
      opportunityTitle: sol.opportunity.title,
      squadId: sol.opportunity.squadId ?? null,
    })),
    opportunities: rawOpportunities.map((opp) => ({
      id: opp.id,
      title: opp.title,
      squadId: opp.squadId ?? null,
    })),
    scheduledSolutionIds: catalogSolutions.filter((sol) => sol.roadmapItems.length > 0).map((sol) => sol.id),
  };

  const unscheduledItems: UnscheduledItem[] = [
    ...catalogSolutions
      .filter((sol) => READY_STATUSES.includes(sol.status) && sol.roadmapItems.length === 0)
      .map((sol) => ({
        kind: "solution" as const,
        id: sol.id,
        title: sol.title,
        opportunityId: sol.opportunityId,
        opportunityTitle: sol.opportunity.title,
        squadId: sol.opportunity.squadId ?? null,
        status: sol.status,
        score: sol.score?.normalizedScore ?? null,
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
            cardSortHref={cardSortHref}
            customFieldGroups={customFieldGroups}
            activeCustomFieldId={customFieldFilter?.fieldId ?? null}
            workspaceId={workspace.id}
            unscheduledItems={unscheduledItems}
            scheduleCatalog={scheduleCatalog}
            roadmapEmpty={activeItemCount === 0}
            initialRailPreference={initialRailPreference}
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
              cardSortHref={cardSortHref}
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
