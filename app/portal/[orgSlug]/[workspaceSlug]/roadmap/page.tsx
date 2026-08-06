import Link from "next/link";
import { MessageSquare } from "lucide-react";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { RoadmapVoteSection } from "@/components/portal/roadmap-vote-section";
import { HORIZON_META, PORTAL_HORIZONS, portalBucketFor } from "@/lib/roadmap";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

type RoadmapItemWithVotes = {
  id: string;
  title: string;
  description: string | null;
  horizon: string;
  _count: { votes: number };
};

// Public columns: NOW / NEXT / LATER / LAUNCHING / SHIPPED. LAUNCHED items
// fold into the Shipped column (portalBucketFor); private items are already
// excluded by the query below.
const HORIZONS = PORTAL_HORIZONS;

export default async function PortalRoadmapPage({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const [workspace, portalSession] = await Promise.all([
    prisma.workspace.findFirst({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
      select: {
        id: true,
        name: true,
        roadmapPublic: true,
        portalAuthRequired: true,
        feedbackEnabled: true,
      },
    }),
    getPortalSession(),
  ]);

  if (!workspace || !workspace.roadmapPublic) {
    return (
      <EmptyState
        title="This roadmap is not public"
        description="The workspace owner has not enabled the public roadmap."
      />
    );
  }

  const rawItems = await prisma.roadmapItem.findMany({
    where: {
      workspaceId: workspace.id,
      status: { not: "ARCHIVED" },
      isPrivate: false,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      description: true,
      horizon: true,
      _count: { select: { votes: true } },
    },
  });

  const itemsByHorizon = HORIZONS.reduce(
    (acc, h) => {
      acc[h] = [];
      return acc;
    },
    {} as Record<string, RoadmapItemWithVotes[]>
  );
  for (const item of rawItems) {
    const bucket = portalBucketFor(item.horizon);
    if (bucket) itemsByHorizon[bucket].push(item);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Public Roadmap"
        description="See what we are working on and vote for what matters to you."
        actions={workspace.feedbackEnabled ? (
          <Button nativeButton={false} render={<Link href={`/portal/${orgSlug}/${workspaceSlug}/feedback`} />} variant="outline">
            <MessageSquare />
            Give Feedback
          </Button>
        ) : undefined}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        {HORIZONS.map((horizon) => (
          <section key={horizon} className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-inset p-3">
            <div className="flex flex-col gap-0.5 border-b border-border-default pb-2">
              <span className="text-sm font-semibold text-text-primary">
                {HORIZON_META[horizon].label}
              </span>
              <span className="text-xs text-text-subtle">{HORIZON_META[horizon].portalDescription}</span>
            </div>
            <div className="flex flex-col gap-2">
              {itemsByHorizon[horizon].length === 0 ? (
                <p className="py-4 text-center text-xs text-text-subtle">Nothing here yet</p>
              ) : (
                itemsByHorizon[horizon].map((item) => (
                  <RoadmapVoteSection
                    key={item.id}
                    item={item}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                    portalAuthRequired={workspace.portalAuthRequired ?? false}
                    portalAccountEmail={portalSession?.email ?? null}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
