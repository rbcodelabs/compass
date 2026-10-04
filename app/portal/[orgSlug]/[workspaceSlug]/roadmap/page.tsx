import Link from "next/link";
import { MessageSquare } from "lucide-react";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { RoadmapVoteSection } from "@/components/portal/roadmap-vote-section";
import { portalBucketFor } from "@/lib/roadmap";
import type { Horizon } from "@/lib/types";
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

// Public view merges the five stored portal buckets into three readable
// columns. LAUNCHED already folds into SHIPPED (portalBucketFor); private
// items are excluded by the query below.
const COLUMNS: { key: string; label: string; description: string; horizons: Horizon[] }[] = [
  { key: "now", label: "Now", description: "In progress and rolling out", horizons: ["NOW", "LAUNCHING"] },
  { key: "next", label: "Coming Up", description: "Planned and on the horizon", horizons: ["NEXT", "LATER"] },
  { key: "shipped", label: "Shipped", description: "Completed and live", horizons: ["SHIPPED"] },
];

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

  const itemsByColumn: Record<string, RoadmapItemWithVotes[]> = {};
  for (const c of COLUMNS) itemsByColumn[c.key] = [];
  for (const item of rawItems) {
    const bucket = portalBucketFor(item.horizon);
    const column = bucket && COLUMNS.find((c) => c.horizons.includes(bucket));
    if (column) itemsByColumn[column.key].push(item);
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
        {COLUMNS.map((column) => (
          <section key={column.key} className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-inset p-3">
            <div className="flex flex-col gap-0.5 border-b border-border-default pb-2">
              <span className="text-sm font-semibold text-text-primary">
                {column.label}
              </span>
              <span className="text-xs text-text-subtle">{column.description}</span>
            </div>
            <div className="flex flex-col gap-2">
              {itemsByColumn[column.key].length === 0 ? (
                <p className="py-4 text-center text-xs text-text-subtle">Nothing here yet</p>
              ) : (
                itemsByColumn[column.key].map((item) => (
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
