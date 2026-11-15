import Link from "next/link"
import { notFound } from "next/navigation"
import { Bot, ChevronLeft, ChevronRight, CircleDashed, ExternalLink, User } from "lucide-react"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { resolveWorkItemPage } from "@/lib/work-item-page"
import { displayIdFromRow } from "@/lib/work-item-ids"
import { getTasksLinkedTo } from "@/lib/task-links-read"
import { decideReviewAction } from "../actions"
import { canDecideReview, isOrgAdminRole } from "@/lib/roles"
import { DecisionActions } from "@/components/decisions/decision-actions"
import { DecisionDetailsGrid, DecisionLongForm, DecisionSummary } from "@/components/decisions/decision-long-form"
import { DecisionSources, parseTrackedDecisionPacket, subjectDestination, subjectTypeLabel } from "@/components/decisions/decision-sources"
import { DecisionArtifacts } from "@/components/decisions/decision-artifacts"
import { DecisionFollowThrough } from "@/components/decisions/decision-follow-through"
import { DecisionOutcomeBanner } from "@/components/decisions/decision-outcome-banner"
import { DecisionEvidenceTabs } from "@/components/decisions/decision-evidence-tabs"
import { SendToAgentPicker } from "@/components/agent/send-to-agent-picker"
import { StatusBadge } from "@/components/patterns/status-badge"
import { buttonVariants } from "@/components/ui/button"
import { getDecisionArtifacts } from "@/lib/artifacts"
import { buildFollowUpDraft, suggestFollowUpAssignee } from "@/lib/decision-followthrough"
import { eligibleTaskAssignees } from "@/lib/task-assignment"
import { isChoiceActionKey, parseDecisionAnswers, parsePacketQuestions } from "@/lib/tracked-decision-types"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { DecisionQuestionList } from "@/components/decisions/decision-answers"
import { TOOL_APPROVAL_SURFACE_MESSAGE, isToolApprovalGate, toolApprovalPath } from "@/lib/tool-approval/gate"
import { resolveRequester } from "@/lib/decision-tool-handlers"
import { decisionStatusBadgeProps, loadPendingQueueNeighbors, resolveDeciderName } from "@/lib/decision-review-view"
import { cn } from "@/lib/utils"

function parsePacket(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
}

export default async function ReviewRequestPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; requestId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { orgSlug, workspaceSlug, requestId: requestParam } = await params
  const session = await auth()
  if (!session?.user?.id) notFound()
  const prisma = getPrisma()
  // The workspace is looked up by slug first so a display ID (DEC-3) resolves inside it. Membership is checked BEFORE
  // the reference is resolved: resolving can 308 to the canonical URL, and that must not tell a non-member that a row exists.
  const scope = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, members: { where: { userId: session.user.id }, select: { id: true } }, organization: { select: { members: { where: { userId: session.user.id }, select: { role: true } } } } },
  })
  if (!scope || (scope.members.length === 0 && !isOrgAdminRole(scope.organization.members[0]?.role))) notFound()
  const resolvedRequest = await resolveWorkItemPage({ type: "reviewRequest", param: requestParam, workspaceId: scope.id, basePath: `/${orgSlug}/${workspaceSlug}/reviews`, searchParams: await searchParams })
  const requestId = resolvedRequest.id
  const request = await prisma.reviewRequest.findFirst({
    where: {
      id: requestId,
      workspace: {
        slug: workspaceSlug,
        organization: { slug: orgSlug },
      },
    },
    include: {
      currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } },
      revisions: { orderBy: { revisionNumber: "desc" }, include: { decisions: { include: { option: true } } } },
      workspace: { include: { members: { where: { userId: session.user.id }, select: { id: true, role: true } }, organization: { include: { members: { where: { userId: session.user.id }, select: { role: true } } } } } },
    },
  })
  if (!request?.currentRevision || (request.workspace.members.length === 0 && !isOrgAdminRole(request.workspace.organization.members[0]?.role))) notFound()
  const { labels } = resolveThinkingModel(request.workspace)
  const revision = request.currentRevision
  const freshness = { stale: Boolean(revision.supersededAt) }
  const packet = parsePacket(revision.packetJson) as {
    roadmapItem?: { title?: string; solutionId?: string | null; opportunityId?: string | null; squadId?: string | null }
    policyVersion?: string
    repositoryOwner?: string
    repositoryName?: string
    pullRequestNumber?: number
    headSha?: string
    baseRef?: string
    targetEnvironment?: string
    releasePolicyId?: string
    taskIds?: string[]
    solution?: { id?: string; title?: string; description?: string | null; status?: string; opportunityId?: string; opportunityTitle?: string }
    mode?: string
    routingFingerprint?: string
    inspection?: { capacityPlanId?: string; capacityPlanFingerprint?: string; verifiedDecisionCount?: number }
    authorityDecisionId?: string
    question?: string
    context?: string
    entity?: { type?: string; id?: string; title?: string }
  }
  const decided = revision.decisions[0]
  const choiceOptions = revision.options.filter((option) => isChoiceActionKey(option.actionKey))
  const questions = request.gateType === "TRACKED_DECISION" ? parsePacketQuestions(revision.packetJson) : []
  const answers = parseDecisionAnswers(decided?.answersJson)
  const isRelease = request.gateType === "RELEASE_AUTHORIZATION"
  const isInvestment = request.gateType === "BUILDING_INVESTMENT" || request.gateType === "BUILDING_INVESTMENT_REVOCATION"
  const isRevocation = request.gateType === "BUILDING_INVESTMENT_REVOCATION"
  const isPolicyActivation = request.gateType === "NOW_POLICY_ACTIVATION"
  const isTracked = request.gateType === "TRACKED_DECISION"
  const isToolApproval = isToolApprovalGate(request.gateType)
  const trackedPacket = isTracked ? parseTrackedDecisionPacket(revision.packetJson) : null
  // The Building-investment gate is retired alongside NOW commitment and native
  // policy activation. Historical rows still render read-only for audit; no new
  // investment review can be created and none can be decided.
  const isRetired = request.gateType === "NOW_COMMITMENT" || isPolicyActivation || isInvestment
  const canDecide = canDecideReview(request.workspace.members[0]?.role, request.workspace.organization.members[0]?.role)
  const canEditArtifacts = request.workspace.members.length > 0
  if (isToolApproval) {
    // Nothing about an approval (title, summary, arguments) is shown on this generic page: members get a 404, admins a pointer to
    // the dedicated approval page, which is the only place that can decide it.
    if (!canDecide) notFound()
    return (
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 overflow-x-hidden p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">Tool approval</p>
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <strong>This approval is decided on its own page.</strong>
          <p className="text-muted-foreground">{TOOL_APPROVAL_SURFACE_MESSAGE}</p>
          <a className="font-medium text-primary underline" href={toolApprovalPath(orgSlug, workspaceSlug, request.id)}>Open the approval page</a>
        </section>
      </main>
    )
  }

  const artifacts = isTracked ? await getDecisionArtifacts(request.workspaceId, requestId) : []
  const availableArtifacts = isTracked && canEditArtifacts ? await prisma.artifact.findMany({
    where: { workspaceId: request.workspaceId, status: "ACTIVE", id: { notIn: artifacts.map((artifact) => artifact.id) } },
    select: { id: true, title: true }, orderBy: [{ title: "asc" }, { id: "asc" }],
  }) : []
  const supportingArtifacts = isTracked ? <DecisionArtifacts workspaceId={request.workspaceId} requestId={requestId} basePath={`/${orgSlug}/${workspaceSlug}/docs`} canEdit={canEditArtifacts} artifacts={artifacts} availableArtifacts={availableArtifacts} /> : null

  // Direction B: a decided decision shows the work it produced, and offers the
  // two ways to resolve producing none. Only loaded once a decision exists —
  // there is nothing to follow through on before then.
  const decidedForFollowUp = isTracked ? revision.decisions[0] : undefined
  const [followUpLinks, assigneeOptions, requester, decidedByName, queue] = await Promise.all([
    decidedForFollowUp
      ? getTasksLinkedTo(prisma, { workspaceIds: [request.workspaceId], linkedType: "DECISION", linkedIds: [requestId] })
      : Promise.resolve([]),
    decidedForFollowUp && canEditArtifacts ? eligibleTaskAssignees(request.workspaceId) : Promise.resolve([]),
    isTracked ? resolveRequester(request) : Promise.resolve(null),
    decided ? resolveDeciderName(decided) : Promise.resolve(null),
    isTracked ? loadPendingQueueNeighbors(request.workspaceId, requestId) : Promise.resolve({ position: null, total: 0, prevRef: null, nextRef: null }),
  ])
  const suggestedAssignee = decidedForFollowUp && canEditArtifacts
    ? await suggestFollowUpAssignee(request.workspaceId, { requestedByAgentId: request.requestedByAgentId, requestedById: request.requestedById })
    : null

  if (!isTracked) {
    const legacyEyebrow = isRelease
      ? "Legacy system decision · Release authorization"
      : isRevocation
        ? "Legacy system decision · Building investment revocation"
        : isInvestment
          ? "Legacy system decision · Building investment"
          : isPolicyActivation
            ? "Legacy system decision · Native policy activation"
            : "Legacy system decision · NOW commitment"

    return (
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 overflow-x-hidden p-4 sm:p-6">
        <div>
          <p className="text-sm text-muted-foreground">{legacyEyebrow}</p>
          <h1 className="break-words [overflow-wrap:anywhere] text-2xl font-semibold">{revision.title}</h1>
          <DecisionSummary tracked={false} summary={revision.summary} />
        </div>
        <section className="min-w-0 max-w-full rounded-lg border p-4 text-sm">
          <DecisionDetailsGrid>
            {isRelease ? <>
              <dt>Repository</dt><dd>{packet.repositoryOwner}/{packet.repositoryName}</dd>
              <dt>Pull request</dt><dd>#{packet.pullRequestNumber}</dd>
              <dt>Reviewed commit</dt><dd className="break-all font-mono">{packet.headSha}</dd>
              <dt>Base ref</dt><dd>{packet.baseRef}</dd>
              <dt>Environment</dt><dd>{packet.targetEnvironment}</dd>
              <dt>Covered tasks</dt><dd>{packet.taskIds?.join(", ")}</dd>
              <dt>Policy</dt><dd>{packet.releasePolicyId}</dd>
            </> : isInvestment ? <>
              <dt>{labels.solution.singular}</dt><dd>{packet.solution?.title}</dd>
              {isRevocation && <><dt>Authority decision</dt><dd className="break-all font-mono">{packet.authorityDecisionId}</dd></>}
              <dt>Status</dt><dd>{packet.solution?.status}</dd>
              <dt>{labels.opportunity.singular}</dt><dd>{packet.solution?.opportunityTitle}</dd>
            </> : isPolicyActivation ? <>
              <dt>Workspace</dt><dd>{request.workspaceId}</dd>
              <dt>Mode</dt><dd>{packet.mode}</dd>
              <dt>Routing</dt><dd className="break-all font-mono">{packet.routingFingerprint}</dd>
              <dt>Capacity plan</dt><dd>{packet.inspection?.capacityPlanId}</dd>
              <dt>Native approvals</dt><dd>{packet.inspection?.verifiedDecisionCount}</dd>
            </> : <>
              <dt>Roadmap item</dt><dd>{packet.roadmapItem?.title}</dd>
              <dt>{labels.solution.singular}</dt><dd>{packet.roadmapItem?.solutionId ?? "Not linked"}</dd>
              <dt>{labels.opportunity.singular}</dt><dd>{packet.roadmapItem?.opportunityId ?? "Not linked"}</dd>
              <dt>Owning squad</dt><dd>{packet.roadmapItem?.squadId ?? "Unassigned"}</dd>
              <dt>Policy</dt><dd>{packet.policyVersion}</dd>
            </>}
            <><dt>Fingerprint</dt><dd className="break-all font-mono">{revision.fingerprint}</dd></>
          </DecisionDetailsGrid>
        </section>
        {isRetired && !decided ? <section className="rounded-lg border p-4 text-sm"><strong>This legacy review is read-only.</strong><p className="text-muted-foreground">Historical evidence remains available for audit.</p></section> : freshness.stale ? (
          <section className="space-y-2 rounded-lg border p-4 text-sm">
            <strong>This review is stale and cannot be decided.</strong>
            <p className="text-muted-foreground">Material inputs changed after this packet was published. Prepare a new immutable revision before deciding.</p>
            {request.gateType === "NOW_COMMITMENT" && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap?detail=roadmapItem:${request.subjectId}`}>Return to Roadmap Item</a>}
            {isPolicyActivation && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap`}>Return to Roadmap</a>}
          </section>
        ) : decided ? (
          <DecisionOutcomeBanner
            label={decided.option.label}
            description={decided.option.description}
            outcomeClass={decided.option.outcomeClass}
            decidedBy={decidedByName ?? decided.actorRole}
            formattedTimestamp={decided.decidedAt.toLocaleString()}
            rationale={decided.rationale}
            answers={answers}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            {revision.options.map((option) => (
              <form key={option.id} action={decideReviewAction.bind(null, { workspaceId: request.workspaceId, revisionId: revision.id, fingerprint: revision.fingerprint, optionId: option.id })}>
                <button className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted" type="submit">{option.label}</button>
              </form>
            ))}
          </div>
        )}
      </main>
    )
  }

  const displayId = displayIdFromRow("reviewRequest", request)
  const statusBadge = decisionStatusBadgeProps({
    state: request.state ?? (decided ? "DECIDED" : "PENDING"),
    outcomeClass: decided?.option.outcomeClass ?? null,
    outcomeLabel: decided?.option.label ?? null,
    stale: freshness.stale,
  })
  const primarySubjectHref = trackedPacket ? subjectDestination(trackedPacket.entity, orgSlug, workspaceSlug) : null
  const primarySubjectType = trackedPacket
    ? subjectTypeLabel(trackedPacket.entity.type, labels)
    : request.subjectType === "OPPORTUNITY"
      ? labels.opportunity.singular
      : request.subjectType === "SOLUTION"
        ? labels.solution.singular
        : request.subjectType.replaceAll("_", " ").toLowerCase()
  const evidenceCount = (trackedPacket ? 1 + trackedPacket.sources.length : 1) + artifacts.length
  const reviewsBasePath = `/${orgSlug}/${workspaceSlug}/reviews`
  const decisionsBasePath = `/${orgSlug}/${workspaceSlug}/decisions`

  const decidedActions = decided ? (
    <>
      {decided.option.outcomeClass === "REQUEST_CHANGES" && (
        <a className="inline-block font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/decisions/new?reviseRequestId=${request.id}`}>
          Create revised request
        </a>
      )}
      {decided.option.outcomeClass === "APPROVE" && (
        <SendToAgentPicker orgSlug={orgSlug} workspaceSlug={workspaceSlug} entityType="decision" entityId={request.id} className="inline-block font-medium text-primary underline">
          Send to agent
        </SendToAgentPicker>
      )}
    </>
  ) : null
  const hasDecidedActions = Boolean(decided && (decided.option.outcomeClass === "REQUEST_CHANGES" || decided.option.outcomeClass === "APPROVE"))

  const sourcesSection = trackedPacket ? (
    <DecisionSources
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      entity={trackedPacket.entity}
      sources={trackedPacket.sources}
      supportingArtifacts={supportingArtifacts}
      labels={labels}
    />
  ) : (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">Linked to</h2>
      <p className="mt-2 text-muted-foreground">{primarySubjectType}</p>
      {supportingArtifacts}
    </div>
  )

  const historySection = request.revisions.length > 1 ? (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-text-primary">History</h2>
      {request.revisions.map((item) => (
        <div key={item.id} className="rounded-xl border border-border-default bg-surface-panel p-4 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <strong className="text-text-primary">Revision {item.revisionNumber}</strong>
            <span className="text-xs text-muted-foreground">{item.createdAt.toLocaleString()}</span>
          </div>
          <p className="mt-1 break-words [overflow-wrap:anywhere] text-text-secondary">{item.title}</p>
          {item.decisions[0] && (
            <div className="mt-2 border-t border-border-subtle pt-2 text-muted-foreground">
              <p className="font-medium text-text-primary">{item.decisions[0].option.label}</p>
              <DecisionLongForm content={item.decisions[0].rationale} />
            </div>
          )}
        </div>
      ))}
    </section>
  ) : undefined

  return (
    <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 overflow-x-hidden p-4 sm:p-6 md:p-8">
      {/* Inbox Triage Top Bar */}
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Link
            href={decisionsBasePath}
            className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
            <span>Decisions</span>
          </Link>
          <span className="text-border-strong" aria-hidden="true">/</span>
          <span className="text-xs text-muted-foreground">Decision</span>
          {displayId && (
            <span data-testid="decision-display-id" className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-text-secondary">
              {displayId}
            </span>
          )}
          <StatusBadge
            status={statusBadge.status}
            icon={!decided && !freshness.stale ? <CircleDashed /> : undefined}
          >
            {statusBadge.label}
          </StatusBadge>
        </div>

        {queue.total > 0 && (
          <nav aria-label="Pending decisions queue" className="flex shrink-0 items-center gap-1.5 text-xs">
            {queue.position !== null ? (
              <>
                <span className="mr-1 text-muted-foreground tabular-nums">
                  {queue.position} of {queue.total} pending
                </span>
                {queue.prevRef ? (
                  <Link
                    href={`${reviewsBasePath}/${queue.prevRef}`}
                    aria-label="Previous pending decision"
                    className={cn(buttonVariants({ variant: "outline", size: "icon-xs" }))}
                  >
                    <ChevronLeft className="size-3.5" aria-hidden="true" />
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className={cn(buttonVariants({ variant: "outline", size: "icon-xs" }), "pointer-events-none opacity-40")}
                  >
                    <ChevronLeft className="size-3.5" aria-hidden="true" />
                  </span>
                )}
                {queue.nextRef ? (
                  <Link
                    href={`${reviewsBasePath}/${queue.nextRef}`}
                    aria-label="Next pending decision"
                    className={cn(buttonVariants({ variant: "outline", size: "icon-xs" }))}
                  >
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className={cn(buttonVariants({ variant: "outline", size: "icon-xs" }), "pointer-events-none opacity-40")}
                  >
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </span>
                )}
              </>
            ) : (
              queue.nextRef && (
                <Link
                  href={`${reviewsBasePath}/${queue.nextRef}`}
                  className={cn(buttonVariants({ variant: "outline", size: "xs" }), "gap-1")}
                >
                  <span>Next pending ({queue.total})</span>
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </Link>
              )
            )}
          </nav>
        )}
      </header>

      {/* Triage Hero Card: Metadata + Question + Above-the-Fold Ballot */}
      <section
        aria-label="Decision triage"
        data-testid="decision-triage-hero"
        className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border-default bg-surface-panel shadow-xs"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border-subtle bg-surface-inset/60 px-4 py-2.5 text-xs text-muted-foreground sm:px-6">
          {trackedPacket ? (
            primarySubjectHref ? (
              <Link
                href={primarySubjectHref}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-2 py-0.5 font-medium text-text-primary transition-colors hover:bg-surface-hover"
              >
                <span className="shrink-0 text-text-subtle">{primarySubjectType}:</span>
                <span className="min-w-0 truncate">{trackedPacket.entity.title}</span>
                <ExternalLink className="size-3 shrink-0 text-text-subtle" aria-hidden="true" />
              </Link>
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-2 py-0.5 font-medium text-text-primary">
                <span className="shrink-0 text-text-subtle">{primarySubjectType}:</span>
                <span className="min-w-0 truncate">{trackedPacket.entity.title}</span>
              </span>
            )
          ) : (
            <span>Linked to {primarySubjectType}</span>
          )}

          {requester && (
            <span className="inline-flex min-w-0 items-center gap-1 text-text-secondary">
              {requester.type === "AGENT" ? (
                <Bot className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
              ) : (
                <User className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
              )}
              <span className="truncate">Requested by {requester.name}</span>
            </span>
          )}

          {typeof revision.revisionNumber === "number" && revision.revisionNumber > 1 && (
            <span className="rounded-full border border-border-default bg-surface-card px-2 py-0.5 font-mono text-[11px] text-text-subtle">
              Revision {revision.revisionNumber}
            </span>
          )}
        </div>

        <div className="px-4 py-4 sm:px-6 sm:py-5">
          <h1 className="break-words [overflow-wrap:anywhere] text-xl font-semibold leading-snug tracking-tight text-text-primary sm:text-2xl">
            {revision.title}
          </h1>
        </div>

        <div className="border-t border-border-subtle bg-surface-inset/35 px-4 py-4 sm:px-6">
          {freshness.stale ? (
            <div className="space-y-1.5 rounded-lg border border-status-warning/30 bg-status-warning-surface p-3.5 text-sm text-status-warning">
              <strong className="block">This review is stale and cannot be decided.</strong>
              <p className="text-foreground/85">Material inputs changed after this packet was published. Prepare a new immutable revision before deciding.</p>
            </div>
          ) : decided ? (
            <DecisionOutcomeBanner
              label={decided.option.label}
              description={decided.option.description}
              outcomeClass={decided.option.outcomeClass}
              decidedBy={decidedByName ?? decided.actorRole}
              formattedTimestamp={decided.decidedAt.toLocaleString()}
              rationale={decided.rationale}
              answers={answers}
              actions={hasDecidedActions ? decidedActions : undefined}
            />
          ) : canDecide ? (
            <DecisionActions
              workspaceId={request.workspaceId}
              revisionId={revision.id}
              fingerprint={revision.fingerprint}
              options={revision.options.map((option) => ({
                id: option.id,
                label: option.label,
                outcomeClass: option.outcomeClass,
                actionKey: option.actionKey,
                description: option.description,
              }))}
              questions={questions}
            />
          ) : (
            <div className="space-y-3 rounded-lg border border-border-default bg-surface-card p-4 text-sm text-muted-foreground">
              <p>Waiting for a workspace or organization admin to decide.</p>
              <DecisionQuestionList questions={questions} />
              {choiceOptions.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium text-foreground">Options offered</p>
                  <ul className="space-y-2">
                    {choiceOptions.map((option) => (
                      <li key={option.id} className="min-w-0 rounded-md border border-border-default bg-background p-3">
                        <span className="block break-words [overflow-wrap:anywhere] font-medium text-foreground">{option.label}</span>
                        {option.description && <span className="mt-0.5 block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{option.description}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Follow-through work bridge (shown immediately below Ballot once decided) */}
      {decidedForFollowUp && (
        <DecisionFollowThrough
          workspaceId={request.workspaceId}
          requestId={requestId}
          tasksBasePath={`/${orgSlug}/${workspaceSlug}/tasks`}
          tasks={followUpLinks.map((link) => link.task)}
          assignees={assigneeOptions.map((option) => ({ type: option.type, id: option.id, displayName: option.displayName, ownerName: option.ownerName }))}
          suggested={suggestedAssignee}
          draft={buildFollowUpDraft({ question: revision.title, outcomeLabel: decidedForFollowUp.option.label, rationale: decidedForFollowUp.rationale })}
          noAction={request.noActionAt ? { reason: request.noActionReason, at: request.noActionAt } : null}
          canEdit={canEditArtifacts}
        />
      )}

      {/* Tabbed Evidence Workspace: Context | Sources & Artifacts | History */}
      <DecisionEvidenceTabs
        contextContent={<DecisionLongForm content={trackedPacket?.context ?? revision.summary} />}
        sourcesContent={sourcesSection}
        evidenceCount={evidenceCount}
        historyContent={historySection}
        revisionCount={request.revisions.length}
      />
    </main>
  )
}
