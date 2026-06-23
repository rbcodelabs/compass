import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { ExperimentCard } from "@/components/experiments/experiment-card"
import { CreateExperimentForm } from "@/components/experiments/create-experiment-form"
import type { Experiment } from "@prisma/client"
import type { ExperimentStatus } from "@/lib/types"

export const metadata = {
  title: "Experiments",
}

interface ExperimentsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

const COLUMNS: { status: ExperimentStatus; label: string }[] = [
  { status: "DESIGNING", label: "Designing" },
  { status: "RUNNING", label: "Running" },
  { status: "COMPLETE", label: "Complete" },
  { status: "KILLED", label: "Killed" },
]

export default async function ExperimentsPage({
  params,
}: ExperimentsPageProps) {
  const { orgSlug, workspaceSlug } = await params

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
  const experiments = await prisma.experiment.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
  })

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Design, run, and conclude experiments to validate assumptions.
          </p>
        </div>
        <CreateExperimentForm workspaceId={workspace.id} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
        {COLUMNS.map(({ status, label }) => {
          const cards = byStatus[status] ?? []
          return (
            <div key={status} className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  {label}
                </h2>
                <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                  {cards.length}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {cards.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No experiments
                  </p>
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
