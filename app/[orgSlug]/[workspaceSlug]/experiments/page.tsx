import { Suspense } from "react"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { ExperimentBoard } from "@/components/experiments/experiment-board"
import { CreateExperimentForm } from "@/components/experiments/create-experiment-form"
import { ExperimentsFilters } from "@/components/experiments/experiments-filters"
import type { AssumptionOptionData, ExperimentStatus, SquadData } from "@/lib/types"
import type { ExperimentCardData } from "@/components/experiments/experiment-card"
import { WorkspacePage } from "@/components/patterns/workspace-page"

export const metadata = {
  title: "Experiments",
}

interface ExperimentsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ squad?: string; assumptionId?: string }>
}

export default async function ExperimentsPage({
  params,
  searchParams,
}: ExperimentsPageProps) {
  const { orgSlug, workspaceSlug } = await params
  const { squad: squadFilter, assumptionId: prefillAssumptionId } = await searchParams

  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    redirect("/login")
  }

  const workspace = await getWorkspace(orgSlug, workspaceSlug, userId)
  if (!workspace) {
    redirect("/dashboard")
  }

  const prisma = getPrisma()

  const [rawSquads, rawExperiments, rawAssumptions] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.experiment.findMany({
      where: {
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        hypothesis: true,
        killCondition: true,
        status: true,
        sortOrder: true,
        conclusion: true,
      },
    }),
    prisma.assumption.findMany({
      where: { solution: { opportunity: { workspaceId: workspace.id } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        solution: {
          select: {
            title: true,
            opportunity: { select: { title: true } },
          },
        },
      },
    }),
  ])

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }))

  const assumptions: AssumptionOptionData[] = rawAssumptions.map((a) => ({
    id: a.id,
    title: a.title,
    solutionTitle: a.solution.title,
    opportunityTitle: a.solution.opportunity.title,
  }))

  const experiments: ExperimentCardData[] = rawExperiments.map((e) => ({
    ...e,
    status: e.status as ExperimentStatus,
  }))

  return (
    <WorkspacePage
      title="Experiments"
      contentClassName="p-0 sm:p-0 md:p-0"
      actions={(
        <>
          <Suspense>
            <ExperimentsFilters squads={squads} />
          </Suspense>
          <CreateExperimentForm
            workspaceId={workspace.id}
            squads={squads}
            assumptions={assumptions}
            prefillAssumptionId={prefillAssumptionId ?? null}
          />
        </>
      )}
    >
      <ExperimentBoard
        key={experiments.map((e) => e.id).join(",")}
        experiments={experiments}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceId={workspace.id}
      />
    </WorkspacePage>
  )
}
