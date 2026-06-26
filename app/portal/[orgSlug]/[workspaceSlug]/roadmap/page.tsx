import getPrisma from "@/lib/db";
import { RoadmapVoteSection } from "@/components/portal/roadmap-vote-section";

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

const HORIZONS = ["NOW", "NEXT", "LATER", "SHIPPED"] as const;

const HORIZON_LABELS: Record<string, string> = {
  NOW: "Now",
  NEXT: "Next",
  LATER: "Later",
  SHIPPED: "Shipped",
};

const HORIZON_DESCRIPTIONS: Record<string, string> = {
  NOW: "In progress or shipping soon",
  NEXT: "Planned for the next cycle",
  LATER: "On the horizon",
  SHIPPED: "Completed and live",
};

export default async function PortalRoadmapPage({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, name: true, roadmapPublic: true },
  });

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
      acc[h] = rawItems.filter((i) => i.horizon === h);
      return acc;
    },
    {} as Record<string, RoadmapItemWithVotes[]>
  );

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Public Roadmap</h1>
        <p className="text-sm text-slate-500 mt-1">
          See what we are working on and vote for what matters to you.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {HORIZONS.map((horizon) => (
          <div key={horizon} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5 pb-2 border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-800">
                {HORIZON_LABELS[horizon]}
              </span>
              <span className="text-xs text-slate-500">{HORIZON_DESCRIPTIONS[horizon]}</span>
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
