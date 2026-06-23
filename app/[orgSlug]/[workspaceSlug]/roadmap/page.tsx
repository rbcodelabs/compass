import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { RoadmapBoard } from "@/components/roadmap/roadmap-board";
import type { Horizon } from "@/lib/types";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";

export const metadata = {
  title: "Roadmap",
};

interface RoadmapPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function RoadmapPage({ params }: RoadmapPageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
  });

  if (!workspace) notFound();

  const items = await prisma.roadmapItem.findMany({
    where: {
      workspaceId: workspace.id,
      status: "ACTIVE",
    },
    orderBy: [{ horizon: "asc" }, { sortOrder: "asc" }],
    include: {
      solution: {
        select: { id: true, title: true },
      },
      keyResult: {
        select: { id: true, title: true, current: true, target: true, unit: true },
      },
    },
  });

  return (
    <div className="flex flex-col flex-1 p-8 gap-6 min-h-0">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight">Roadmap</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Drag items between horizons to update your plan.
        </p>
      </div>

      <RoadmapBoard
        initialItems={items.map((item) => ({ ...item, horizon: item.horizon as Horizon })) as RoadmapCardData[]}
        workspaceId={workspace.id}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
