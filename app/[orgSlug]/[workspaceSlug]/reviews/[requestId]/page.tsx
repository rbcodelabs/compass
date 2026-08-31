import { notFound } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { decideReviewAction } from "../actions"

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
        OR: [
          { members: { some: { userId: session.user.id } } },
          { organization: { members: { some: { userId: session.user.id, role: { in: ["OWNER", "ADMIN", "owner", "admin"] } } } } },
        ],
      },
    },
    include: {
      currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } },
    },
  })
  if (!request?.currentRevision) notFound()
  const revision = request.currentRevision
  const packet = JSON.parse(revision.packetJson) as { roadmapItem?: { title?: string; solutionId?: string | null; opportunityId?: string | null; squadId?: string | null }; policyVersion?: string }
  const decided = revision.decisions[0]

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">NOW commitment review</p>
        <h1 className="text-2xl font-semibold">{revision.title}</h1>
        <p className="mt-2 text-muted-foreground">{revision.summary}</p>
      </div>
      <section className="rounded-lg border p-4 text-sm">
        <dl className="grid grid-cols-[10rem_1fr] gap-2">
          <dt>Roadmap item</dt><dd>{packet.roadmapItem?.title}</dd>
          <dt>Solution</dt><dd>{packet.roadmapItem?.solutionId ?? "Not linked"}</dd>
          <dt>Opportunity</dt><dd>{packet.roadmapItem?.opportunityId ?? "Not linked"}</dd>
          <dt>Owning squad</dt><dd>{packet.roadmapItem?.squadId ?? "Unassigned"}</dd>
          <dt>Policy</dt><dd>{packet.policyVersion}</dd>
          <dt>Fingerprint</dt><dd className="break-all font-mono">{revision.fingerprint}</dd>
        </dl>
      </section>
      {decided ? (
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
