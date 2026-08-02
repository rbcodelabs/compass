import Link from "next/link";
import { MessageSquare } from "lucide-react";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { RoadmapVoteSection } from "@/components/portal/roadmap-vote-section";
import { HORIZON_META, PORTAL_HORIZONS, portalBucketFor } from "@/lib/roadmap";

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
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-lg font-semibold text-slate-700">This roadmap is not public</p>
        <p className="text-sm text-slate-500 mt-1">
          The workspace owner has not enabled the public roadmap.
        </p>
      </div>
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
      <div className="flex flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Public Roadmap</h1>
          <p className="text-sm text-slate-500 mt-1">
            See what we are working on and vote for what matters to you.
          </p>
        </div>
        {workspace.feedbackEnabled && (
          <Link
            href={`/portal/${orgSlug}/${workspaceSlug}/feedback`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 shrink-0"
          >
            <MessageSquare className="w-4 h-4" />
            Give Feedback
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        {HORIZONS.map((horizon) => (
          <div key={horizon} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5 pb-2 border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-800">
                {HORIZON_META[horizon].label}
              </span>
              <span className="text-xs text-slate-500">{HORIZON_META[horizon].portalDescription}</span>
            </div>
            <div className="flex flex-col gap-2">
              {itemsByHorizon[horizon].length === 0 ? (
                <p className="text-xs text-slate-400 py-4 text-center">Nothing here yet</p>
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
          </div>
        ))}
      </div>
    </div>
  );
}
