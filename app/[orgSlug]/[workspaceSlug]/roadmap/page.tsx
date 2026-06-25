import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { RoadmapBoard } from "@/components/roadmap/roadmap-board";
import { SquadFilterBar } from "@/components/squads/squad-filter-bar";
import type { Horizon, SquadData } from "@/lib/types";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";

export const metadata = {
  title: "Roadmap",
};

interface RoadmapPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ squad?: string }>;
}

export default async function RoadmapPage({ params, searchParams }: RoadmapPageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const { squad: squadFilter } = await searchParams;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
  });

  if (!workspace) notFound();

  const [rawSquads, items, rawKRs, rawSolutions, rawOpportunities, rawExperiments] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.roadmapItem.findMany({
      where: {
        workspaceId: workspace.id,
        status: "ACTIVE",
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: [{ horizon: "asc" }, { sortOrder: "asc" }],
      include: {
        solution: {
          select: { id: true, title: true },
        },
        keyResult: {
          select: {
            id: true,
            title: true,
            current: true,
            target: true,
            unit: true,
            objective: { select: { cycleId: true } },
          },
        },
        opportunity: {
          select: { id: true, title: true },
        },
        experiment: {
          select: { id: true, title: true },
        },
      },
    }),
    prisma.keyResult.findMany({
      where: { objective: { cycle: { workspaceId: workspace.id } } },
      select: {
        id: true,
        title: true,
        objective: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.solution.findMany({
      where: { opportunity: { workspaceId: workspace.id } },
      select: {
        id: true,
        title: true,
        opportunity: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.opportunity.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
      select: { id: true, title: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.experiment.findMany({
      where: { workspaceId: workspace.id, status: { not: "KILLED" } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const availableKRs = rawKRs.map((kr) => ({
    id: kr.id,
    title: kr.title,
    objectiveTitle: kr.objective.title,
  }));

  const availableSolutions = rawSolutions.map((sol) => ({
    id: sol.id,
    title: sol.title,
    opportunityTitle: sol.opportunity.title,
  }));

  const availableExperiments = rawExperiments.map((exp) => ({
    id: exp.id,
    title: exp.title,
    status: exp.status,
  }));

  const cardItems: RoadmapCardData[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description ?? null,
    horizon: item.horizon as Horizon,
    sortOrder: item.sortOrder,
    solutionId: item.solutionId ?? null,
    keyResultId: item.keyResultId ?? null,
    opportunityId: item.opportunityId ?? null,
    experimentId: item.experimentId ?? null,
    solution: item.solution ?? null,
    keyResult: item.keyResult
      ? {
          id: item.keyResult.id,
          title: item.keyResult.title,
          current: item.keyResult.current,
          target: item.keyResult.target,
          unit: item.keyResult.unit,
          cycleId: item.keyResult.objective?.cycleId ?? null,
        }
      : null,
    opportunity: item.opportunity ?? null,
    experiment: item.experiment ?? null,
  }));

  return (
    <div className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6 min-h-0">
      <div className="shrink-0">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">Roadmap</h1>
        <p className="text-slate-500 text-sm mt-1">
          Drag items between horizons to update your plan.
        </p>
      </div>

      <Suspense>
        <SquadFilterBar squads={squads} />
      </Suspense>

      <div className="overflow-x-auto min-w-0">
        <RoadmapBoard
          initialItems={cardItems}
          workspaceId={workspace.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          availableKRs={availableKRs}
          availableSolutions={availableSolutions}
          availableOpportunities={rawOpportunities}
          availableExperiments={availableExperiments}
        />
      </div>
    </div>
  );
}
