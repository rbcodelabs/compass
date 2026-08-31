"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { recordDecision } from "@/lib/decision-service"
import { admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"

async function requireWorkspaceMember(workspaceId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: {
      id: workspaceId,
      OR: [
        { members: { some: { userId: session.user.id } } },
        { organization: { members: { some: { userId: session.user.id, role: { in: ["OWNER", "ADMIN", "owner", "admin"] } } } } },
      ],
    },
    select: { id: true },
  })
  if (!workspace) throw new Error("Workspace not found")
  return session.user.id
}

export async function requestNowCommitmentAction(workspaceId: string, itemId: string) {
  const userId = await requireWorkspaceMember(workspaceId)
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
  const userId = await requireWorkspaceMember(input.workspaceId)
  const decision = await recordDecision({
    actor: { kind: "USER", userId },
    revisionId: input.revisionId,
    fingerprint: input.fingerprint,
    optionId: input.optionId,
    rationale: input.rationale,
    idempotencyKey: `review:${input.revisionId}:${input.optionId}:${userId}`,
  })
  const prisma = getPrisma()
  const selected = await prisma.reviewOption.findUnique({ where: { id: input.optionId } })
  if (selected?.continuationKey === "ADMIT_ROADMAP_ITEM_TO_NOW" && selected.outcomeClass === "APPROVE") {
    const revision = await prisma.reviewRevision.findUnique({ where: { id: input.revisionId }, include: { request: true } })
    if (!revision) throw new Error("Review revision not found")
    await admitRoadmapItemToNow(revision.request.subjectId, decision.id)
  }
  revalidatePath("/", "layout")
}
