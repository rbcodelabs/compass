import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { DiscoveryFilters } from "@/components/discovery/discovery-filters";
import { DiscoverySortToggle } from "@/components/discovery/discovery-sort-toggle";
import { DiscoveryViewToggle } from "@/components/discovery/discovery-view-toggle";
import { SolutionBacklogBoard, type SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";
import { SolutionTableView } from "@/components/solutions/solution-table-view";
import { SolutionSavedViewsMenu } from "@/components/solutions/solution-saved-views";
import { SolutionColumnsPopover } from "@/components/solutions/solution-columns-popover";
import { SolutionsColumnLayoutProvider } from "@/components/solutions/solutions-column-layout";
import { legacyOrderToLayout } from "@/lib/solutions/board-layout";
import { resolveSolutionColumns } from "@/lib/saved-views/solution-columns";
import {
  needsSolutionsViewExpansion,
  resolveSolutionsState,
  solutionsHref,
  solutionsPageParams,
  type SolutionsState,
} from "@/lib/saved-views/solutions-state";
import { listSavedViews, resolveSavedViewActor } from "@/lib/saved-views/service";
import { SolutionGroupByToggle } from "@/components/solutions/solution-group-by-toggle";
import { NewSolutionDialog } from "@/components/solutions/new-solution-dialog";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { resolveWorkspaceAccess } from "@/lib/workspace-context";
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
import { SOLUTION_BOARD_STATUSES } from "@/lib/saved-views/schema";
import type { SolutionStatus, SquadData } from "@/lib/types";

const boardColumnStatuses: readonly string[] = SOLUTION_BOARD_STATUSES;

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
    saved?: string;
    edited?: string;
    order?: string;
    hide?: string;
  }>;
};

export default async function SolutionsPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const search = await searchParams;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) notFound();
  const workspaceAccess = session.user?.id ? await resolveWorkspaceAccess(orgSlug, workspaceSlug, session.user.id) : null;

  // Saved views (personal). A stale, foreign or invisible ?saved= id falls through to the defaults.
  const savedActor = session.user?.id ? await resolveSavedViewActor(session.user.id, orgSlug) : null;
  const savedViews = savedActor ? await listSavedViews(savedActor, "SOLUTIONS_BOARD", workspace.id) : [];
  const savedParam = Array.isArray(search.saved) ? search.saved[0] : search.saved;
  const selectedView = savedParam ? (savedViews.find((v) => v.id === savedParam) ?? null) : null;
  const selectedState: SolutionsState | null = selectedView
    ? { filters: selectedView.filters as SolutionsState["filters"], display: selectedView.display as SolutionsState["display"] }
    : null;
  const boardState = resolveSolutionsState(search, selectedState);
  // A bare ?saved=id becomes the full (edited=1) form, so every control keeps editing single params.
  if (selectedView && needsSolutionsViewExpansion(search)) {
    redirect(solutionsHref(`/${orgSlug}/${workspaceSlug}/solutions`, boardState, selectedView.id));
  }
  const {
    squad: squadFilter,
    sort,
    view,
    groupBy: requestedGroupBy,
    field: fieldParam,
    fieldValue: fieldValueParam,
  } = solutionsPageParams(boardState);

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
  const columnCounts = Object.fromEntries(
    boardColumnStatuses.map((status) => [status, solutions.filter((solution) => solution.status === status).length]),
  );
  const boardColumns = resolveSolutionColumns(boardState.display.columns.status, columnCounts);

  // Where the board's column layout starts. The layout is client state (see solutions-column-layout.tsx); it supersedes
  // the older columns.status.order, which is still read: a selected view's own layout, else the layout its legacy order
  // describes, and an explicit legacy ?order= link wins over a view that has no layout of its own. A legacy ?order= with
  // no view starts the layout too (as a source of its own, so it is not mirrored to this browser's storage).
  const urlOrder = typeof search.order === "string" ? boardState.display.columns.status?.order : undefined;
  const layoutSource = selectedView && selectedState
    ? {
        id: selectedView.id,
        version: selectedView.updatedAt,
        columnLayout: selectedState.display.columnLayout ?? legacyOrderToLayout(urlOrder ?? selectedState.display.columns.status?.order),
      }
    : urlOrder && urlOrder.length > 0
      ? { id: "url-order", version: urlOrder.join(","), columnLayout: legacyOrderToLayout(urlOrder) }
      : null;

  return (
    // The header (saved-views menu, Columns popover) and the board are siblings; they share the column layout through this provider.
    <SolutionsColumnLayoutProvider workspaceId={workspace.id} savedView={layoutSource}>
    <WorkspacePage
      title={thinkingModel.labels.solution.plural}
      contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}
      actions={(
        <Suspense>
          <div className="flex items-center gap-2">
            <SolutionSavedViewsMenu
              savedViews={{
                orgSlug,
                workspaceId: workspace.id,
                views: savedViews,
                savedViewId: selectedView?.id ?? null,
                canSave: !(workspaceAccess?.isReadOnly ?? true),
              }}
            />
            <DiscoveryViewToggle view={view} />
            {view === "board" && (
              <SolutionGroupByToggle
                groupBy={groupBy}
                fieldOptions={groupableFields.map((field) => ({ id: field.id, label: field.name }))}
              />
            )}
            {hasActiveScoringModel && <DiscoverySortToggle sort={sort} />}
            {view === "board" && groupBy === "status" && (
              <SolutionColumnsPopover
                workspaceId={workspace.id}
                savedViews={{ views: savedViews, savedViewId: selectedView?.id ?? null }}
                columns={boardColumns}
                countsByStatus={columnCounts}
              />
            )}
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
          editing={{ parents: parentOpportunities, readOnly: workspaceAccess?.isReadOnly ?? true }}
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
          columnOrder={boardColumns.visible}
          forcedVisibleColumns={boardColumns.forcedVisible}
          groupField={groupField ? { id: groupField.id, name: groupField.name, options: groupField.options ?? [] } : null}
        />
      )}
    </WorkspacePage>
    </SolutionsColumnLayoutProvider>
  );
}
