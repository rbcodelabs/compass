import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { DiscoveryFilters } from "@/components/discovery/discovery-filters";
import { DiscoverySortToggle, type DiscoverySort } from "@/components/discovery/discovery-sort-toggle";
import { SolutionBacklogBoard, type SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions";
import {
  buildCustomFieldFilterGroups,
  parseCustomFieldFilterParams,
  resolveCustomFieldFilter,
} from "@/lib/custom-field-filter";
import { resolveWorkspaceScoringModel, toScoreSummary } from "@/lib/scoring-model";
import { solutionBacklogKey } from "@/lib/solution-backlog";
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
    field?: string;
    fieldValue?: string;
  }>;
};

export default async function SolutionsPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const { squad: squadFilter, sort: requestedSort, field: fieldParam, fieldValue: fieldValueParam } = await searchParams;
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
  const [fieldDefs, customFieldFilter, rawSquads, solutionScoringModel] = await Promise.all([
    loadCustomFieldDefinitions(prisma, { workspaceId: workspace.id, objectTypes: ["SOLUTION"] }),
    resolveCustomFieldFilter(prisma, {
      workspaceId: workspace.id,
      objectTypes: ["SOLUTION"],
      filter: parseCustomFieldFilterParams({ field: fieldParam, fieldValue: fieldValueParam }),
    }),
    prisma.squad.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
    // null when the workspace has no active Solution model: no score UI, no sort toggle.
    resolveWorkspaceScoringModel(workspace.id, "SOLUTION"),
  ]);
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
  }));

  return (
    <WorkspacePage
      title={thinkingModel.labels.solution.plural}
      contentClassName="p-0 sm:p-0 md:p-0"
      actions={(
        <Suspense>
          <div className="flex items-center gap-2">
            {hasActiveScoringModel && <DiscoverySortToggle sort={sort} />}
            <DiscoveryFilters
              squads={squads}
              customFieldGroups={customFieldGroups}
              activeCustomFieldId={customFieldFilter?.fieldId ?? null}
            />
          </div>
        </Suspense>
      )}
    >
      <SolutionBacklogBoard
        key={solutionBacklogKey(solutions)}
        solutions={solutions}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceId={workspace.id}
        hasActiveScoringModel={hasActiveScoringModel}
        sortByScore={sort === "score"}
      />
    </WorkspacePage>
  );
}
