import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { DiscoveryFilters } from "@/components/discovery/discovery-filters";
import { DiscoverySortToggle, type DiscoverySort } from "@/components/discovery/discovery-sort-toggle";
import { DiscoveryViewToggle, type DiscoveryView } from "@/components/discovery/discovery-view-toggle";
import { SolutionBacklogBoard, type SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";
import { SolutionTableView } from "@/components/solutions/solution-table-view";
import { SolutionGroupByToggle } from "@/components/solutions/solution-group-by-toggle";
import { NewSolutionDialog } from "@/components/solutions/new-solution-dialog";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions";
import {
  buildCustomFieldFilterGroups,
  parseCustomFieldFilterParams,
  resolveCustomFieldFilter,
} from "@/lib/custom-field-filter";
import { resolveWorkspaceScoringModel, toScoreSummary } from "@/lib/scoring-model";
import { solutionBacklogKey } from "@/lib/solution-backlog";
import {
  groupableSolutionFields,
  orderSolutionsForTable,
  resolveSolutionGroupBy,
  solutionGroupByFieldId,
} from "@/lib/solution-backlog-grouping";
import { columnValueFor } from "@/lib/opportunity-field-board";
import { loadCustomFieldValuesForObjects } from "@/lib/custom-field-values-batch";
import { objectTypeLabels } from "@/components/custom-fields/object-type-labels";
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server";
import type { SolutionStatus, SquadData } from "@/lib/types";

export async function generateMetadata({ params }: Pick<Props, "params">) {
  const { orgSlug, workspaceSlug } = await params;
  const { labels } = await getThinkingModelForSlugs(orgSlug, workspaceSlug);
  return { title: labels.solution.plural };
}

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{
    squad?: string;
    sort?: string;
    view?: string;
    groupBy?: string;
    field?: string;
    fieldValue?: string;
  }>;
};

export default async function SolutionsPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const {
    squad: squadFilter,
    sort: requestedSort,
    view: requestedView,
    groupBy: requestedGroupBy,
    field: fieldParam,
    fieldValue: fieldValueParam,
  } = await searchParams;
  const view: DiscoveryView = requestedView === "table" ? "table" : "board";
  const sort: DiscoverySort = requestedSort === "score" ? "score" : "manual";
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) notFound();

  const thinkingModel = await getThinkingModelForSlugs(orgSlug, workspaceSlug);

  // Only Solution fields apply here: a stale Opportunity-field filter resolves
  // to null and is ignored rather than hiding every card.
  const [fieldDefs, customFieldFilter, rawSquads, solutionScoringModel, parentOpportunities] = await Promise.all([
    loadCustomFieldDefinitions(prisma, { workspaceId: workspace.id, objectTypes: ["SOLUTION"] }),
    resolveCustomFieldFilter(prisma, {
      workspaceId: workspace.id,
      objectTypes: ["SOLUTION"],
      filter: parseCustomFieldFilterParams({ field: fieldParam, fieldValue: fieldValueParam }),
    }),
    prisma.squad.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
    // null when the workspace has no active Solution model: no score UI, no sort toggle.
    resolveWorkspaceScoringModel(workspace.id, "SOLUTION"),
    // Parents offered by "New solution": this workspace's own, non-archived Opportunities.
    prisma.opportunity.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true },
    }),
  ]);
  // Stale or ineligible field ids fall back to Status (see resolveSolutionGroupBy).
  const groupableFields = groupableSolutionFields(fieldDefs);
  const groupBy = view === "board" ? resolveSolutionGroupBy(requestedGroupBy, groupableFields) : "status";
  const groupFieldId = solutionGroupByFieldId(groupBy);
  const groupField = groupFieldId ? (groupableFields.find((field) => field.id === groupFieldId) ?? null) : null;
  const customFieldGroups = buildCustomFieldFilterGroups(fieldDefs, objectTypeLabels(thinkingModel.labels));

  const rows = await prisma.solution.findMany({
    where: {
      // Scoped by the Solution's own workspaceId, never through the parent chain.
      workspaceId: workspace.id,
      // Squad belongs to the parent Opportunity; a Solution has none of its own.
      ...(squadFilter ? { opportunity: { squadId: squadFilter } } : {}),
      ...(customFieldFilter ? { id: { in: customFieldFilter.objectIds } } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      sortOrder: true,
      score: { select: { normalizedScore: true, modelVersion: true } },
      _count: { select: { evidence: true, assumptions: true } },
      opportunity: { select: { id: true, title: true, squadId: true } },
    },
  });

  // Only a field grouping needs these values; one batched query.
  const groupFieldValues = groupField
    ? await loadCustomFieldValuesForObjects(prisma, { fieldId: groupField.id, objectIds: rows.map((row) => row.id) })
    : null;

  const squads: SquadData[] = rawSquads.map((s) => ({ id: s.id, name: s.name, color: s.color }));
  const squadMap = new Map(squads.map((s) => [s.id, s]));
  const hasActiveScoringModel = solutionScoringModel !== null;

  const solutions: SolutionBacklogItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as SolutionStatus,
    sortOrder: row.sortOrder,
    _count: row._count,
    // null whenever there is no score row *or* no active Solution model.
    score: toScoreSummary(row.score, solutionScoringModel),
    opportunity: {
      id: row.opportunity.id,
      title: row.opportunity.title,
      squad: row.opportunity.squadId ? (squadMap.get(row.opportunity.squadId) ?? null) : null,
    },
    ...(groupField && groupFieldValues
      ? { fieldValue: columnValueFor(groupFieldValues.get(row.id), groupField.options ?? []) }
      : {}),
  }));
  const scoreSort = hasActiveScoringModel && sort === "score";

  return (
    <WorkspacePage
      title={thinkingModel.labels.solution.plural}
      contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}
      actions={(
        <Suspense>
          <div className="flex items-center gap-2">
            <DiscoveryViewToggle view={view} />
            {view === "board" && (
              <SolutionGroupByToggle
                groupBy={groupBy}
                fieldOptions={groupableFields.map((field) => ({ id: field.id, label: field.name }))}
              />
            )}
            {hasActiveScoringModel && <DiscoverySortToggle sort={sort} />}
            <DiscoveryFilters
              squads={squads}
              customFieldGroups={customFieldGroups}
              activeCustomFieldId={customFieldFilter?.fieldId ?? null}
            />
            <NewSolutionDialog opportunities={parentOpportunities} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
          </div>
        </Suspense>
      )}
    >
      {view === "table" ? (
        <SolutionTableView
          solutions={orderSolutionsForTable(solutions, scoreSort)}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          hasActiveScoringModel={hasActiveScoringModel}
        />
      ) : (
        <SolutionBacklogBoard
          // Keyed on the grouping too: switching it must not reuse optimistic status-board state.
          key={`${groupBy}:${solutionBacklogKey(solutions)}`}
          solutions={solutions}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
          hasActiveScoringModel={hasActiveScoringModel}
          sortByScore={sort === "score"}
          groupBy={groupBy}
          squads={squads}
          groupField={groupField ? { id: groupField.id, name: groupField.name, options: groupField.options ?? [] } : null}
        />
      )}
    </WorkspacePage>
  );
}
