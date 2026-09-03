"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { recordDecision } from "@/lib/decision-service"
import { admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"
import { isOrgAdminRole } from "@/lib/roles"
import { queueAuthorizedRelease, unconfiguredReleaseSourceRevalidator } from "@/lib/release-authorization"

async function requireWorkspaceMember(workspaceId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId },
    select: {
      id: true,
      members: { where: { userId: session.user.id }, select: { id: true } },
      organization: { select: { members: { where: { userId: session.user.id }, select: { role: true } } } },
    },
  })
  if (!workspace || (workspace.members.length === 0 && !isOrgAdminRole(workspace.organization.members[0]?.role))) throw new Error("Workspace not found")
  return session.user.id
}

export async function requestNowCommitmentAction(_workspaceId: string, itemId: string) {
  const prisma = getPrisma()
  const item = await prisma.roadmapItem.findUnique({ where: { id: itemId }, select: { id: true, workspaceId: true } })
  if (!item) throw new Error("Roadmap item not found")
  const userId = await requireWorkspaceMember(item.workspaceId)
  const revision = await prepareNowCommitment(itemId, { requestedById: userId })
  revalidatePath("/", "layout")
  return { requestId: revision.requestId, revisionId: revision.id }
}

export async function decideReviewAction(input: {
  workspaceId: string
  revisionId: string
  fingerprint: string
  optionId: string
  rationale?: string
}) {
  const prisma = getPrisma()
  const revision = await prisma.reviewRevision.findUnique({ where: { id: input.revisionId }, include: { request: true } })
  if (!revision) throw new Error("Review revision not found")
  const userId = await requireWorkspaceMember(revision.request.workspaceId)
  const decision = await recordDecision({
    actor: { kind: "USER", userId },
    revisionId: input.revisionId,
    fingerprint: input.fingerprint,
    optionId: input.optionId,
    rationale: input.rationale,
    idempotencyKey: `review:${input.revisionId}:${input.optionId}:${userId}`,
  })
  const selected = await prisma.reviewOption.findUnique({ where: { id: input.optionId } })
  if (selected?.continuationKey === "ADMIT_ROADMAP_ITEM_TO_NOW" && selected.outcomeClass === "APPROVE") {
    await admitRoadmapItemToNow(revision.request.subjectId, decision.id)
  }
  if (selected?.continuationKey === "DISPATCH_RELEASE_RUN" && selected.outcomeClass === "APPROVE") {
    if (!revision.sourceFingerprint) throw new Error("Release review is missing its immutable source fingerprint")
    const dispatch = await queueAuthorizedRelease(
      revision.request.subjectId,
      decision.id,
      revision.sourceFingerprint,
      unconfiguredReleaseSourceRevalidator,
    )
    if (dispatch.status === "BLOCKED") throw new Error(`Release dispatch blocked: ${dispatch.code}`)
  }
  revalidatePath("/", "layout")
}
