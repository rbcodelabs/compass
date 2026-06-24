import { Suspense } from "react"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { ExperimentCard } from "@/components/experiments/experiment-card"
import { CreateExperimentForm } from "@/components/experiments/create-experiment-form"
import { SquadFilterBar } from "@/components/squads/squad-filter-bar"
import { FlaskConical } from "lucide-react"
import type { Experiment } from "@prisma/client"
import type { ExperimentStatus, SquadData } from "@/lib/types"

export const metadata = {
  title: "Experiments",
}

interface ExperimentsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ squad?: string }>
}

const COLUMNS: { status: ExperimentStatus; label: string; color: string }[] = [
  { status: "DESIGNING", label: "Designing", color: "bg-slate-400" },
  { status: "RUNNING", label: "Running", color: "bg-blue-500" },
  { status: "COMPLETE", label: "Complete", color: "bg-emerald-500" },
  { status: "KILLED", label: "Killed", color: "bg-red-400" },
]

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

  const [rawSquads, experiments] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.experiment.findMany({
      where: {
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
    }),
  ])

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }))

  const byStatus = experiments.reduce<Record<string, Experiment[]>>(
    (acc, exp) => {
      if (!acc[exp.status]) acc[exp.status] = []
      acc[exp.status].push(exp)
      return acc
    },
    {}
  )

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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
        {COLUMNS.map(({ status, label, color }) => {
          const cards = byStatus[status] ?? []
          return (
            <div key={status} className="flex flex-col gap-2">
              {/* Column header */}
              <div className="flex items-center gap-2 px-1 mb-1">
                <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} aria-hidden="true" />
                <span className="text-sm font-semibold text-slate-700">{label}</span>
                <span className="ml-auto text-xs font-medium text-slate-400 bg-slate-200/60 rounded-full px-2 py-0.5 tabular-nums">
                  {cards.length}
                </span>
              </div>

              {/* Card well */}
              <div className="flex flex-col gap-2 rounded-xl bg-slate-100/80 p-2.5 min-h-[180px]">
                {cards.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 flex-1 min-h-[120px] rounded-lg border border-dashed border-slate-300/70 py-6">
                    <div className="w-8 h-8 rounded-full bg-slate-200/70 flex items-center justify-center">
                      <FlaskConical className="w-4 h-4 text-slate-400" />
                    </div>
                    <p className="text-xs text-slate-400">No experiments yet</p>
                  </div>
                ) : (
                  cards.map((exp) => (
                    <ExperimentCard
                      key={exp.id}
                      experiment={exp}
                      href={`/${orgSlug}/${workspaceSlug}/experiments/${exp.id}`}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
