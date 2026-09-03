import { notFound } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { decideReviewAction } from "../actions"
import { isOrgAdminRole } from "@/lib/roles"
import { ensureBuildingInvestmentRevisionFresh, ensureBuildingInvestmentRevocationRevisionFresh } from "@/lib/building-investment"

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
      workspace: { include: { members: { where: { userId: session.user.id }, select: { id: true } }, organization: { include: { members: { where: { userId: session.user.id }, select: { role: true } } } } } },
    },
  })
  if (!request?.currentRevision || (request.workspace.members.length === 0 && !isOrgAdminRole(request.workspace.organization.members[0]?.role))) notFound()
  const revision = request.currentRevision
  const freshness = request.gateType === "BUILDING_INVESTMENT"
      ? await ensureBuildingInvestmentRevisionFresh(revision.id)
      : request.gateType === "BUILDING_INVESTMENT_REVOCATION"
        ? await ensureBuildingInvestmentRevocationRevisionFresh(revision.id)
      : { stale: Boolean(revision.supersededAt) }
  const packet = JSON.parse(revision.packetJson) as {
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
  }
  const decided = revision.decisions[0]
  const isRelease = request.gateType === "RELEASE_AUTHORIZATION"
  const isInvestment = request.gateType === "BUILDING_INVESTMENT" || request.gateType === "BUILDING_INVESTMENT_REVOCATION"
  const isRevocation = request.gateType === "BUILDING_INVESTMENT_REVOCATION"
  const isPolicyActivation = request.gateType === "NOW_POLICY_ACTIVATION"
  const isRetired = request.gateType === "NOW_COMMITMENT" || isPolicyActivation

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">{isRetired ? "Legacy system decision" : isRelease ? "Release authorization review" : isRevocation ? "Building investment revocation review" : "Building investment review"}</p>
        <h1 className="text-2xl font-semibold">{revision.title}</h1>
        <p className="mt-2 text-muted-foreground">{revision.summary}</p>
      </div>
      <section className="rounded-lg border p-4 text-sm">
        <dl className="grid grid-cols-[10rem_1fr] gap-2">
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
          <dt>Fingerprint</dt><dd className="break-all font-mono">{revision.fingerprint}</dd>
        </dl>
      </section>
      {isRetired && !decided ? <section className="rounded-lg border p-4 text-sm"><strong>This legacy review is read-only.</strong><p className="text-muted-foreground">Compass no longer uses native NOW enforcement. Historical evidence remains available for audit.</p></section> : freshness.stale ? (
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <strong>This review is stale and cannot be decided.</strong>
          <p className="text-muted-foreground">Material inputs changed after this packet was published. Prepare a new immutable revision before deciding.</p>
          {request.gateType === "NOW_COMMITMENT" && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap?detail=roadmapItem:${request.subjectId}`}>Return to Roadmap Item</a>}
          {isInvestment && packet.solution?.opportunityId && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/discovery/${packet.solution.opportunityId}`}>Return to Solution</a>}
          {isPolicyActivation && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap`}>Return to Roadmap</a>}
        </section>
      ) : decided ? (
        <section className="rounded-lg border bg-status-success-surface p-4 text-sm text-status-success">
          Decision recorded: <strong>{decided.option.label}</strong> by {decided.actorRole} at {decided.decidedAt.toISOString()}.
        </section>
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
