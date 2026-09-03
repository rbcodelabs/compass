import { notFound } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { decideReviewAction } from "../actions"
import { ensureNowCommitmentRevisionFresh } from "@/lib/now-commitment"
import { isOrgAdminRole } from "@/lib/roles"

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
  const freshness = request.gateType === "NOW_COMMITMENT"
    ? await ensureNowCommitmentRevisionFresh(revision.id)
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
  }
  const decided = revision.decisions[0]
  const isRelease = request.gateType === "RELEASE_AUTHORIZATION"

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">{isRelease ? "Release authorization review" : "NOW commitment review"}</p>
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
      {freshness.stale ? (
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <strong>This review is stale and cannot be decided.</strong>
          <p className="text-muted-foreground">Material inputs changed after this packet was published. Prepare a new immutable revision before deciding.</p>
          {!isRelease && <a className="font-medium text-primary underline" href={`/${orgSlug}/${workspaceSlug}/roadmap?detail=roadmapItem:${request.subjectId}`}>Return to Roadmap Item</a>}
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
