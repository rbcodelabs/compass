import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ResultItem } from "@/components/experiments/result-item"
import { LogResultForm } from "@/components/experiments/log-result-form"
import { ConcludePanel } from "@/components/experiments/conclude-panel"
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel"
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions"
import { SquadPicker } from "@/components/squads/squad-picker"
import { startExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"
import { ChevronLeftIcon } from "lucide-react"
import { EmptyState } from "@/components/patterns/empty-state"
import { PageHeader } from "@/components/patterns/page-header"
import { StatusBadge } from "@/components/patterns/status-badge"
import { MarkdownContent } from "@/components/markdown-content"
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link"
import { PmInterviewHistory } from "@/components/research/pm-interview-history"
import { isPmInterviewEnabled, isResearchCaptureEnabled } from "@/lib/research-feature"
import { ExperimentResearchLinksSection } from "@/components/research/experiment-research-links-section"
import type { CustomFieldDefinitionData, CustomFieldValue, SquadData } from "@/lib/types"
import { MeasurementsPanel } from "@/components/analytics/measurements-panel"

interface ExperimentDetailPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; id: string }>
}

const STATUS_LABELS: Record<string, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
  NOT_PURSUED: "Not Pursued",
}

const STATUS_TONE = {
  DESIGNING: "neutral",
  RUNNING: "info",
  COMPLETE: "success",
  KILLED: "danger",
  NOT_PURSUED: "neutral",
} as const

const CONCLUSION_TONE = {
  PROCEED: "success",
  KILL: "danger",
  ITERATE: "warning",
  // Neutral, not danger — this was never tested, so it must read differently
  // from KILL (an evidence-based failure) at a glance.
  NOT_PURSUED: "neutral",
} as const

const CONCLUSION_LABELS: Record<string, string> = {
  PROCEED: "Proceed",
  KILL: "Kill",
  ITERATE: "Iterate",
  NOT_PURSUED: "Not Pursued",
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
  const [experiment, rawSquads] = await Promise.all([
    prisma.experiment.findFirst({
      where: { id, workspaceId: workspace.id },
      include: {
        results: { orderBy: { createdAt: "asc" } },
        assumption: true,
      },
    }),
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
  ])

  if (!experiment) {
    notFound()
  }

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }))
  const pmInterviews = isPmInterviewEnabled() ? await prisma.pMInterview.findMany({
    where: { workspaceId: workspace.id, targetType: "EXPERIMENT", targetId: id },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, disposition: true, generationState: true, agentConversationId: true, createdAt: true },
  }) : []

  // Custom fields for this experiment
  const fieldDefs = await prisma.customFieldDefinition.findMany({
    where: { workspaceId: workspace.id, objectType: "EXPERIMENT" },
    orderBy: { order: "asc" },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  const fieldValues = fieldDefs.length > 0
    ? await prisma.customFieldValue.findMany({
        where: { fieldId: { in: fieldDefs.map((f) => f.id) }, objectId: id },
      })
    : []
  const valueByFieldId = new Map(fieldValues.map((v) => [v.fieldId, v.value]))
  const customFields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }> =
    fieldDefs.map((f) => ({
      ...toCustomFieldDefinitionData(f),
      objectType: "EXPERIMENT" as const,
      currentValue: (valueByFieldId.get(f.id) ?? null) as CustomFieldValue,
    }))

  const experimentDetailPath = `/${orgSlug}/${workspaceSlug}/experiments/${id}`

  const statusLabel = STATUS_LABELS[experiment.status] ?? experiment.status
  const statusTone = STATUS_TONE[experiment.status as keyof typeof STATUS_TONE] ?? "neutral"
  const isActive =
    experiment.status === "RUNNING" || experiment.status === "DESIGNING"
  const canStart = experiment.status === "DESIGNING"

  const backHref = `/${orgSlug}/${workspaceSlug}/experiments`

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6 max-w-3xl mx-auto w-full">
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
            <MarkdownContent className="text-amber-900 dark:text-amber-200">{experiment.killCondition}</MarkdownContent>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4">
        <PageHeader
          title={experiment.title}
          actions={(
            <>
              <StatusBadge status={statusTone}>{statusLabel}</StatusBadge>
              {experiment.conclusion && (
                <StatusBadge status={CONCLUSION_TONE[experiment.conclusion as keyof typeof CONCLUSION_TONE] ?? "neutral"}>
                  {CONCLUSION_LABELS[experiment.conclusion] ?? experiment.conclusion}
                </StatusBadge>
              )}
            </>
          )}
        />
        {isPmInterviewEnabled() && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="EXPERIMENT" targetId={id} />}

        {/* Conclusion rationale — the durable "why" behind the conclusion,
            most important for NOT_PURSUED where no evidence was generated. */}
        {experiment.conclusionReason && (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <p className="text-xs font-medium text-muted-foreground mb-0.5">
              Reason
            </p>
            <p className="text-sm text-foreground/80 whitespace-pre-wrap">
              {experiment.conclusionReason}
            </p>
          </div>
        )}

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

        {squads.length > 0 && (
          <SquadPicker
            objectType="experiment"
            objectId={id}
            currentSquadId={experiment.squadId}
            squads={squads}
            revalidatePathStr={experimentDetailPath}
          />
        )}
      </div>

      <Separator />

      {/* Experiment details */}
      <div className="flex flex-col gap-5">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Hypothesis
          </h2>
          <MarkdownContent className="border-l-4 border-muted pl-4 italic text-foreground/80">{experiment.hypothesis}</MarkdownContent>
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Method
          </h2>
          <MarkdownContent className="text-foreground/80">{experiment.method}</MarkdownContent>
        </section>

        {isResearchCaptureEnabled() && <ExperimentResearchLinksSection orgSlug={orgSlug} workspaceSlug={workspaceSlug} target={{ type: "experiment", id }} />}

        {/* Kill condition shown again in body when not active (collapsed after conclusion) */}
        {!isActive && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <span aria-hidden="true" className="text-amber-500">
                &#9888;
              </span>
              Kill Condition
            </h2>
            <MarkdownContent className="text-foreground/80">{experiment.killCondition}</MarkdownContent>
          </section>
        )}
      </div>

      {customFields.length > 0 && (
        <>
          <Separator />
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Custom Fields
            </h2>
            <CustomFieldsPanel
              fields={customFields}
              objectId={id}
              revalidatePathStr={experimentDetailPath}
            />
          </section>
        </>
      )}

      <Separator />

      <MeasurementsPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        target={{ targetType: "EXPERIMENT", targetId: id }}
      />

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
          <EmptyState
            compact
            title="No results logged yet"
            description={isActive ? "Log a result to record observations from this experiment." : undefined}
          />
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
      <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={pmInterviews} />
    </main>
  )
}
