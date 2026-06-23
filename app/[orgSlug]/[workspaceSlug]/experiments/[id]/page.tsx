import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ResultItem } from "@/components/experiments/result-item"
import { LogResultForm } from "@/components/experiments/log-result-form"
import { ConcludePanel } from "@/components/experiments/conclude-panel"
import { startExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"
import { ChevronLeftIcon } from "lucide-react"

interface ExperimentDetailPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; id: string }>
}

const STATUS_LABELS: Record<string, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
}

const STATUS_CLASS: Record<string, string> = {
  DESIGNING: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  RUNNING: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  COMPLETE:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  KILLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
}

const CONCLUSION_LABELS: Record<string, string> = {
  PROCEED: "Proceed",
  KILL: "Kill",
  ITERATE: "Iterate",
}

export default async function ExperimentDetailPage({
  params,
}: ExperimentDetailPageProps) {
  const { orgSlug, workspaceSlug, id } = await params

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
  const experiment = await prisma.experiment.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      results: { orderBy: { createdAt: "asc" } },
      assumption: true,
    },
  })

  if (!experiment) {
    notFound()
  }

  const statusLabel = STATUS_LABELS[experiment.status] ?? experiment.status
  const statusClass = STATUS_CLASS[experiment.status] ?? ""
  const isActive =
    experiment.status === "RUNNING" || experiment.status === "DESIGNING"
  const canStart = experiment.status === "DESIGNING"

  const backHref = `/${orgSlug}/${workspaceSlug}/experiments`

  return (
    <main className="flex flex-col flex-1 p-8 gap-6 max-w-3xl mx-auto w-full">
      {/* Back navigation */}
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <ChevronLeftIcon className="size-4" />
        All experiments
      </Link>

      {/* Kill condition — hard gate, always at top when active */}
      {isActive && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30 px-4 py-3 flex gap-3">
          <span
            aria-hidden="true"
            className="text-xl text-amber-600 dark:text-amber-400 shrink-0"
          >
            &#9888;
          </span>
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-0.5">
              Kill Condition
            </p>
            <p className="text-sm text-amber-900 dark:text-amber-200">
              {experiment.killCondition}
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            {experiment.title}
          </h1>
          <div className="flex items-center gap-2 shrink-0">
            <Badge className={statusClass}>{statusLabel}</Badge>
            {experiment.conclusion && (
              <Badge variant="outline">
                {CONCLUSION_LABELS[experiment.conclusion] ??
                  experiment.conclusion}
              </Badge>
            )}
          </div>
        </div>

        {/* Dates */}
        {(experiment.startDate || experiment.endDate) && (
          <div className="flex gap-4 text-sm text-muted-foreground">
            {experiment.startDate && (
              <span>
                Started{" "}
                {new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(new Date(experiment.startDate))}
              </span>
            )}
            {experiment.endDate && (
              <span>
                Ended{" "}
                {new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(new Date(experiment.endDate))}
              </span>
            )}
          </div>
        )}

        {/* Linked assumption */}
        {experiment.assumption && (
          <div className="text-sm text-muted-foreground">
            Testing assumption:{" "}
            <span className="text-foreground font-medium">
              {experiment.assumption.title}
            </span>
          </div>
        )}
      </div>

      <Separator />

      {/* Experiment details */}
      <div className="flex flex-col gap-5">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Hypothesis
          </h2>
          <blockquote className="border-l-4 border-muted pl-4 text-sm italic text-foreground/80">
            {experiment.hypothesis}
          </blockquote>
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Method
          </h2>
          <p className="text-sm text-foreground/80 whitespace-pre-wrap">
            {experiment.method}
          </p>
        </section>

        {/* Kill condition shown again in body when not active (collapsed after conclusion) */}
        {!isActive && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <span aria-hidden="true" className="text-amber-500">
                &#9888;
              </span>
              Kill Condition
            </h2>
            <p className="text-sm text-foreground/80 whitespace-pre-wrap">
              {experiment.killCondition}
            </p>
          </section>
        )}
      </div>

      <Separator />

      {/* Results section */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            Results
            {experiment.results.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({experiment.results.length})
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {canStart && (
              <form
                action={async () => {
                  "use server"
                  await startExperiment(experiment.id)
                }}
              >
                <Button type="submit" variant="outline" size="sm">
                  Start Experiment
                </Button>
              </form>
            )}
            {isActive && (
              <LogResultForm experimentId={experiment.id} />
            )}
          </div>
        </div>

        {experiment.results.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No results logged yet.
            {isActive && <> Click &ldquo;Log Result&rdquo; to record observations.</>}
          </p>
        ) : (
          <div>
            {experiment.results.map((result) => (
              <ResultItem key={result.id} result={result} />
            ))}
          </div>
        )}

        {/* Conclude panel — only when experiment is active */}
        {isActive && (
          <div className="pt-2">
            <ConcludePanel
              experimentId={experiment.id}
              killCondition={experiment.killCondition}
            />
          </div>
        )}
      </div>
    </main>
  )
}
