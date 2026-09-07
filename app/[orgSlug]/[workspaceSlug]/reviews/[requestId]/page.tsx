import { notFound } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { decideReviewAction } from "../actions"
import { canDecideReview, isOrgAdminRole } from "@/lib/roles"
import { ensureBuildingInvestmentRevisionFresh, ensureBuildingInvestmentRevocationRevisionFresh } from "@/lib/building-investment"
import { DecisionActions } from "@/components/decisions/decision-actions"
import { DecisionDetailsGrid, DecisionLongForm, DecisionSummary } from "@/components/decisions/decision-long-form"
import { DecisionSources, parseTrackedDecisionPacket } from "@/components/decisions/decision-sources"

function parsePacket(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
}

export default async function ReviewRequestPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string; requestId: string }> }) {
  const { orgSlug, workspaceSlug, requestId } = await params
  const session = await auth()
  if (!session?.user?.id) notFound()
  const prisma = getPrisma()
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
  const revision = request.currentRevision
  const freshness = request.gateType === "BUILDING_INVESTMENT"
      ? await ensureBuildingInvestmentRevisionFresh(revision.id)
      : request.gateType === "BUILDING_INVESTMENT_REVOCATION"
        ? await ensureBuildingInvestmentRevocationRevisionFresh(revision.id)
      : { stale: Boolean(revision.supersededAt) }
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
  const isRelease = request.gateType === "RELEASE_AUTHORIZATION"
  const isInvestment = request.gateType === "BUILDING_INVESTMENT" || request.gateType === "BUILDING_INVESTMENT_REVOCATION"
  const isRevocation = request.gateType === "BUILDING_INVESTMENT_REVOCATION"
  const isPolicyActivation = request.gateType === "NOW_POLICY_ACTIVATION"
  const isTracked = request.gateType === "TRACKED_DECISION"
  const trackedPacket = isTracked ? parseTrackedDecisionPacket(revision.packetJson) : null
  const isRetired = request.gateType === "NOW_COMMITMENT" || isPolicyActivation
  const canDecide = canDecideReview(request.workspace.members[0]?.role, request.workspace.organization.members[0]?.role)

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 overflow-x-hidden p-4 sm:p-6">
      <div>
        <p className="text-sm text-muted-foreground">{isTracked ? "Decision" : isRelease ? "Legacy system decision · Release authorization" : isRevocation ? "Legacy system decision · Building investment revocation" : isInvestment ? "Building investment review" : isPolicyActivation ? "Legacy system decision · Native policy activation" : "Legacy system decision · NOW commitment"}</p>
        <h1 className="break-words [overflow-wrap:anywhere] text-2xl font-semibold">{revision.title}</h1>
        <DecisionSummary tracked={isTracked} summary={revision.summary} />
      </div>
      <section className="min-w-0 max-w-full rounded-lg border p-4 text-sm">
        {isTracked ? <div className="space-y-5">
          {trackedPacket
            ? <DecisionSources orgSlug={orgSlug} workspaceSlug={workspaceSlug} entity={trackedPacket.entity} sources={trackedPacket.sources} />
            : <div><h2 className="text-sm font-medium">Linked to</h2><p className="mt-2 text-muted-foreground">{request.subjectType.replaceAll("_", " ").toLowerCase()}</p></div>}
          <div className="border-t pt-4">
            <h2 className="mb-2 text-sm font-medium">Context</h2>
            <DecisionLongForm content={trackedPacket?.context ?? revision.summary} />
          </div>
        </div> : <DecisionDetailsGrid>
          {isRelease ? <>
            <dt>Repository</dt><dd>{packet.repositoryOwner}/{packet.repositoryName}</dd>
            <dt>Pull request</dt><dd>#{packet.pullRequestNumber}</dd>
            <dt>Reviewed commit</dt><dd className="break-all font-mono">{packet.headSha}</dd>
            <dt>Base ref</dt><dd>{packet.baseRef}</dd>
            <dt>Environment</dt><dd>{packet.targetEnvironment}</dd>
            <dt>Covered tasks</dt><dd>{packet.taskIds?.join(", ")}</dd>
            <dt>Policy</dt><dd>{packet.releasePolicyId}</dd>
          </> : isInvestment ? <>
            <dt>Solution</dt><dd>{packet.solution?.title}</dd>
            {isRevocation && <><dt>Authority decision</dt><dd className="break-all font-mono">{packet.authorityDecisionId}</dd></>}
            <dt>Status</dt><dd>{packet.solution?.status}</dd>
            <dt>Opportunity</dt><dd>{packet.solution?.opportunityTitle}</dd>
          </> : isPolicyActivation ? <>
            <dt>Workspace</dt><dd>{request.workspaceId}</dd>
            <dt>Mode</dt><dd>{packet.mode}</dd>
            <dt>Routing</dt><dd className="break-all font-mono">{packet.routingFingerprint}</dd>
            <dt>Capacity plan</dt><dd>{packet.inspection?.capacityPlanId}</dd>
            <dt>Native approvals</dt><dd>{packet.inspection?.verifiedDecisionCount}</dd>
          </> : <>
            <dt>Roadmap item</dt><dd>{packet.roadmapItem?.title}</dd>
            <dt>Solution</dt><dd>{packet.roadmapItem?.solutionId ?? "Not linked"}</dd>
            <dt>Opportunity</dt><dd>{packet.roadmapItem?.opportunityId ?? "Not linked"}</dd>
            <dt>Owning squad</dt><dd>{packet.roadmapItem?.squadId ?? "Unassigned"}</dd>
            <dt>Policy</dt><dd>{packet.policyVersion}</dd>
          </>}
          <><dt>Fingerprint</dt><dd className="break-all font-mono">{revision.fingerprint}</dd></>
        </DecisionDetailsGrid>}
      </section>
      {isRetired && !decided ? <section className="rounded-lg border p-4 text-sm"><strong>This legacy review is read-only.</strong><p className="text-muted-foreground">Historical evidence remains available for audit.</p></section> : freshness.stale ? (
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <strong>This review is stale and cannot be decided.</strong>
          <p className="text-muted-foreground">Material inputs changed after this packet was published. Prepare a new immutable revision before deciding.</p>
          {request.gateType === "NOW_COMMITMENT" && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap?detail=roadmapItem:${request.subjectId}`}>Return to Roadmap Item</a>}
          {isInvestment && packet.solution?.opportunityId && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/discovery/${packet.solution.opportunityId}`}>Return to Solution</a>}
          {isPolicyActivation && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap`}>Return to Roadmap</a>}
        </section>
      ) : decided ? (
        <section className="space-y-2 rounded-lg border bg-status-success-surface p-4 text-sm text-status-success">
          <p>Decision recorded: <strong>{decided.option.label}</strong> by {decided.actorRole} at {decided.decidedAt.toLocaleString()}.</p>
          <DecisionLongForm className="text-foreground" content={decided.rationale} />
          {isTracked && decided.option.outcomeClass === "REQUEST_CHANGES" && <a className="inline-block font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/decisions/new?reviseRequestId=${request.id}`}>Create revised request</a>}
        </section>
      ) : isTracked && canDecide ? (
        <DecisionActions workspaceId={request.workspaceId} revisionId={revision.id} fingerprint={revision.fingerprint} options={revision.options.map((option) => ({ id: option.id, label: option.label, outcomeClass: option.outcomeClass }))} />
      ) : isTracked ? (
        <section className="rounded-lg border p-4 text-sm text-muted-foreground">Waiting for a workspace or organization admin to decide.</section>
      ) : (
        <div className="flex flex-wrap gap-3">
          {revision.options.map((option) => (
            <form key={option.id} action={decideReviewAction.bind(null, { workspaceId: request.workspaceId, revisionId: revision.id, fingerprint: revision.fingerprint, optionId: option.id })}>
              <button className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted" type="submit">{option.label}</button>
            </form>
          ))}
        </div>
      )}
      {isTracked && request.revisions.length > 1 && <section className="space-y-3"><h2 className="text-lg font-semibold">History</h2>{request.revisions.map((item) => <div key={item.id} className="rounded-lg border p-4 text-sm"><div className="flex justify-between gap-3"><strong>Revision {item.revisionNumber}</strong><span className="text-muted-foreground">{item.createdAt.toLocaleString()}</span></div><p className="mt-1">{item.title}</p>{item.decisions[0] && <div className="mt-2 text-muted-foreground"><p>{item.decisions[0].option.label}</p><DecisionLongForm content={item.decisions[0].rationale} /></div>}</div>)}</section>}
    </main>
  )
}
