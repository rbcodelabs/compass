import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { OpportunityBoard } from "@/components/discovery/opportunity-board";
import { CreateOpportunityDialog } from "@/components/discovery/create-opportunity-dialog";
import type { OpportunityStatus } from "@/lib/types";
import type { OpportunityCardData } from "@/components/discovery/opportunity-card";

export const metadata = {
  title: "Discovery",
};

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

const ACTIVE_STATUSES: OpportunityStatus[] = [
  "EXPLORING",
  "VALIDATING",
  "PRIORITIZED",
  "ACTIVE",
];

export default async function DiscoveryPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
    select: { id: true, name: true },
  });

  if (!workspace) notFound();

  const opportunities = await prisma.opportunity.findMany({
    where: {
      workspaceId: workspace.id,
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      customerSegment: true,
      status: true,
      _count: { select: { solutions: true } },
    },
  });

  const archivedOpportunities = await prisma.opportunity.findMany({
    where: {
      workspaceId: workspace.id,
      status: "ARCHIVED",
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      customerSegment: true,
      status: true,
      _count: { select: { solutions: true } },
    },
  });

  const opportunitiesByStatus = ACTIVE_STATUSES.reduce(
    (acc, status) => {
      acc[status] = opportunities
        .filter((o) => o.status === status)
        .map((o) => ({ ...o, status: o.status as OpportunityStatus }));
      return acc;
    },
    {} as Record<OpportunityStatus, OpportunityCardData[]>
  );

  return (
    <main className="flex flex-col flex-1 p-6 gap-6 min-w-0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Discovery</h1>
          <p className="text-sm text-muted-foreground">
            Opportunity Solution Tree for {workspace.name}
          </p>
        </div>
        <CreateOpportunityDialog workspaceId={workspace.id} />
      </div>

      <OpportunityBoard
        opportunitiesByStatus={opportunitiesByStatus}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />

      {archivedOpportunities.length > 0 && (
        <ArchivedSection
          opportunities={archivedOpportunities.map((o) => ({ ...o, status: o.status as OpportunityStatus }))}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      )}
    </main>
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
    <details className="group">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors select-none">
          <span className="group-open:rotate-90 transition-transform inline-block">
            ▶
          </span>
          <span>Archived ({opportunities.length})</span>
        </div>
      </summary>
      <div className="mt-3 flex flex-wrap gap-3">
        {opportunities.map((opp) => (
          <div
            key={opp.id}
            className="rounded-xl ring-1 ring-border/60 bg-muted/40 p-3 w-[280px]"
          >
            <a
              href={`/${orgSlug}/${workspaceSlug}/discovery/${opp.id}`}
              className="text-sm font-medium line-clamp-2 hover:underline underline-offset-2 text-muted-foreground"
            >
              {opp.title}
            </a>
            {opp.customerSegment && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {opp.customerSegment}
              </p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
