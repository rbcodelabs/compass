import { Suspense } from "react"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { ExperimentBoard } from "@/components/experiments/experiment-board"
import { CreateExperimentForm } from "@/components/experiments/create-experiment-form"
import { SquadFilterBar } from "@/components/squads/squad-filter-bar"
import type { ExperimentStatus, SquadData } from "@/lib/types"
import type { ExperimentCardData } from "@/components/experiments/experiment-card"

export const metadata = {
  title: "Experiments",
}

interface ExperimentsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ squad?: string }>
}

export default async function ExperimentsPage({
  params,
  searchParams,
}: ExperimentsPageProps) {
  const { orgSlug, workspaceSlug } = await params
  const { squad: squadFilter } = await searchParams

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

  const [rawSquads, rawExperiments] = await Promise.all([
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
  ])

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }))

  const experiments: ExperimentCardData[] = rawExperiments.map((e) => ({
    ...e,
    status: e.status as ExperimentStatus,
  }))

  return (
    <main className="flex flex-col flex-1 p-8 gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Experiments</h1>
          <p className="text-sm text-slate-500 mt-1">
            Design, run, and conclude experiments to validate assumptions.
          </p>
        </div>
        <CreateExperimentForm workspaceId={workspace.id} squads={squads} />
      </div>

      <Suspense>
        <SquadFilterBar squads={squads} />
      </Suspense>

      <ExperimentBoard
        key={experiments.map((e) => e.id).join(",")}
        experiments={experiments}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceId={workspace.id}
      />
    </main>
  )
}
