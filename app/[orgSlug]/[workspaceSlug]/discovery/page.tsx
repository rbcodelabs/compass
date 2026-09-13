import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { OpportunityBoard } from "@/components/discovery/opportunity-board";
import { DiscoveryFilters } from "@/components/discovery/discovery-filters";
import { DiscoveryTableView, type DiscoveryTableOpportunity } from "@/components/discovery/discovery-table-view";
import { DiscoveryViewToggle, type DiscoveryView } from "@/components/discovery/discovery-view-toggle";
import { DiscoveryGroupByToggle, type DiscoveryGroupBy } from "@/components/discovery/discovery-group-by-toggle";
import { DiscoverySortToggle, type DiscoverySort } from "@/components/discovery/discovery-sort-toggle";
import { SolutionSwimlaneBoard, type SwimlaneOpportunity } from "@/components/discovery/solution-swimlane-board";
import { resolveWorkspaceScoringModel, toScoreSummary } from "@/lib/scoring-model";
import type { OpportunityStatus, SolutionStatus, SquadData } from "@/lib/types";
import type { OpportunityCardData } from "@/components/discovery/opportunity-card";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export const metadata = {
  title: "Discovery",
};

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ squad?: string; view?: string; groupBy?: string; sort?: string }>;
};

const ACTIVE_STATUSES: OpportunityStatus[] = [
  "EXPLORING",
  "VALIDATING",
  "PRIORITIZED",
  "ACTIVE",
];

export default async function DiscoveryPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const {
    squad: squadFilter,
    view: requestedView,
    groupBy: requestedGroupBy,
    sort: requestedSort,
  } = await searchParams;
  const view: DiscoveryView = requestedView === "table" ? "table" : "board";
  const groupBy: DiscoveryGroupBy = requestedGroupBy === "opportunity" ? "opportunity" : "status";
  const sort: DiscoverySort = requestedSort === "score" ? "score" : "manual";
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
    select: { id: true, name: true },
  });

  if (!workspace) notFound();

  const [rawSquads, opportunities, archivedOpportunities, evidenceSourceCounts, scoringModel] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.opportunity.findMany({
      where: {
        workspaceId: workspace.id,
        status: { in: ACTIVE_STATUSES },
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        customerSegment: true,
        status: true,
        sortOrder: true,
        squadId: true,
        score: { select: { normalizedScore: true, modelVersion: true } },
        _count: { select: { solutions: true, evidence: true } },
        solutions: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            sortOrder: true,
            _count: { select: { evidence: true, assumptions: true } },
          },
        },
      },
    }),
    prisma.opportunity.findMany({
      where: {
        workspaceId: workspace.id,
        status: "ARCHIVED",
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        customerSegment: true,
        status: true,
        sortOrder: true,
        squadId: true,
        score: { select: { normalizedScore: true, modelVersion: true } },
        _count: { select: { solutions: true, evidence: true } },
      },
    }),
    // Distinct source-type count per opportunity, used for the "from N sources" badge.
    prisma.evidence.groupBy({
      by: ["opportunityId", "sourceType"],
      where: { workspaceId: workspace.id, opportunityId: { not: null } },
    }),
    // null when the workspace has no active model — the board then renders no
    // score UI and no sort toggle at all, same gate as the detail page.
    resolveWorkspaceScoringModel(workspace.id),
  ]);

  const hasActiveScoringModel = scoringModel !== null;

  const sourceCountByOpportunity = new Map<string, number>();
  for (const row of evidenceSourceCounts) {
    if (!row.opportunityId) continue;
    sourceCountByOpportunity.set(
      row.opportunityId,
      (sourceCountByOpportunity.get(row.opportunityId) ?? 0) + 1
    );
  }

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const squadMap = new Map(squads.map((s) => [s.id, s]));

  function toCardData(o: {
    id: string;
    title: string;
    customerSegment: string | null;
    status: string;
    sortOrder: number;
    squadId: string | null;
    score: { normalizedScore: number; modelVersion: number } | null;
    _count: { solutions: number; evidence: number };
  }): OpportunityCardData {
    return {
      id: o.id,
      title: o.title,
      customerSegment: o.customerSegment,
      status: o.status as OpportunityStatus,
      sortOrder: o.sortOrder,
      _count: o._count,
      evidenceSourceCount: sourceCountByOpportunity.get(o.id) ?? 0,
      squad: o.squadId ? (squadMap.get(o.squadId) ?? null) : null,
      // null whenever there is no score row *or* no active model.
      score: toScoreSummary(o.score, scoringModel),
    };
  }

  const opportunitiesByStatus = ACTIVE_STATUSES.reduce(
    (acc, status) => {
      acc[status] = opportunities.filter((o) => o.status === status).map(toCardData);
      return acc;
    },
    {} as Record<OpportunityStatus, OpportunityCardData[]>
  );

  const tableOpportunities: DiscoveryTableOpportunity[] = ACTIVE_STATUSES.flatMap((status) =>
    opportunities
      .filter((opportunity) => opportunity.status === status)
      .map((opportunity) => ({
        id: opportunity.id,
        title: opportunity.title,
        customerSegment: opportunity.customerSegment,
        status: opportunity.status as OpportunityStatus,
        sortOrder: opportunity.sortOrder,
        squad: opportunity.squadId ? (squadMap.get(opportunity.squadId) ?? null) : null,
        evidenceCount: opportunity._count.evidence,
        solutions: opportunity.solutions.map((solution) => ({
          id: solution.id,
          title: solution.title,
          status: solution.status as SolutionStatus,
          sortOrder: solution.sortOrder,
          evidenceCount: solution._count.evidence,
          assumptionCount: solution._count.assumptions,
        })),
      }))
  );

  // Lanes are exactly the Opportunities shown on today's board — same
  // ACTIVE_STATUSES + squad filter, same order — mapped into the shape
  // SolutionSwimlaneBoard needs instead of bucketed by Opportunity status.
  const swimlaneOpportunities: SwimlaneOpportunity[] = opportunities.map((opportunity) => ({
    id: opportunity.id,
    title: opportunity.title,
    squad: opportunity.squadId ? (squadMap.get(opportunity.squadId) ?? null) : null,
    solutions: opportunity.solutions.map((solution) => ({
      id: solution.id,
      title: solution.title,
      description: solution.description,
      status: solution.status as SolutionStatus,
      sortOrder: solution.sortOrder,
      _count: solution._count,
    })),
  }));

  return (
    <WorkspacePage
      title="Discovery"
      contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}
      actions={(
        <Suspense>
          <div className="flex items-center gap-2">
            <DiscoveryViewToggle view={view} />
            {view === "board" && <DiscoveryGroupByToggle groupBy={groupBy} />}
            {view === "board" && groupBy === "status" && hasActiveScoringModel && (
              <DiscoverySortToggle sort={sort} />
            )}
            <DiscoveryFilters squads={squads} />
          </div>
        </Suspense>
      )}
    >
      {view === "table" ? (
        <DiscoveryTableView opportunities={tableOpportunities} />
      ) : groupBy === "opportunity" ? (
        <SolutionSwimlaneBoard
          key={opportunities
            .map((o) => o.id)
            .concat(opportunities.flatMap((o) => o.solutions.map((s) => s.id)))
            .join(",")}
          opportunities={swimlaneOpportunities}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
        />
      ) : (
        <OpportunityBoard
          key={opportunities.map((o) => o.id).join(",")}
          opportunitiesByStatus={opportunitiesByStatus}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
          squads={squads}
          hasActiveScoringModel={hasActiveScoringModel}
          sortByScore={sort === "score"}
        />
      )}

      {archivedOpportunities.length > 0 && (
        <div className={view === "board" ? "shrink-0 px-3 pb-3 sm:px-4 sm:pb-4" : "mt-3 shrink-0"}>
          <ArchivedSection
            opportunities={archivedOpportunities.map(toCardData)}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </div>
      )}
    </WorkspacePage>
  );
}

function ArchivedSection({
  opportunities,
  orgSlug,
  workspaceSlug,
}: {
  opportunities: OpportunityCardData[];
  orgSlug: string;
  workspaceSlug: string;
}) {
  return (
    <Collapsible className="group">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="text-muted-foreground" />}>
        <ChevronRight className="transition-transform group-data-open:rotate-90" />
        Archived ({opportunities.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
      <div className="mt-3 flex flex-wrap gap-3">
        {opportunities.map((opp) => (
          <div
            key={opp.id}
            className="rounded-xl ring-1 ring-border/60 bg-muted/40 p-3 w-[280px]"
          >
            <div className="flex items-start gap-1.5">
              {opp.squad && (
                <span
                  className="mt-0.5 w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: opp.squad.color }}
                />
              )}
              <a
                href={`/${orgSlug}/${workspaceSlug}/discovery/${opp.id}`}
                className="text-sm font-medium line-clamp-2 hover:underline underline-offset-2 text-muted-foreground"
              >
                {opp.title}
              </a>
            </div>
            {opp.customerSegment && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {opp.customerSegment}
              </p>
            )}
          </div>
        ))}
      </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
