"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { recordDecision } from "@/lib/decision-service"
import { isOrgAdminRole } from "@/lib/roles"
import { queueAuthorizedRelease, unconfiguredReleaseSourceRevalidator } from "@/lib/release-authorization"
import { createTrackedDecisionRequest, reviseTrackedDecisionRequest, recordDecisionNoAction, type TrackedSubjectType } from "@/lib/tracked-decisions"
import { createDecisionFollowUpTask } from "@/lib/decision-followthrough"
import type { TaskAssignee } from "@/lib/task-assignment"

/**
 * Gates whose designs were retired but whose historical rows still exist. They
 * render read-only for audit and can never be decided again: NOW commitment and
 * native policy activation were retired in f5d7510, and the Building-investment
 * gate — whose approvals nothing downstream ever read — with it.
 */
const RETIRED_GATE_TYPES = new Set([
  "NOW_COMMITMENT",
  "NOW_POLICY_ACTIVATION",
  "BUILDING_INVESTMENT",
  "BUILDING_INVESTMENT_REVOCATION",
])

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

export async function createTrackedDecisionAction(input: {
  workspaceId: string
  subjectType: TrackedSubjectType
  subjectId: string
  question: string
  context: string
  idempotencyKey: string
  revise?: { requestId: string; expectedDecisionId: string; reason: string }
}) {
  const userId = await requireWorkspaceMember(input.workspaceId)
  const { revise, idempotencyKey, ...request } = input
  const revision = revise
    ? await reviseTrackedDecisionRequest({ ...request, ...revise, requestedById: userId })
    : await createTrackedDecisionRequest({ ...request, idempotencyKey, requestedById: userId })
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
  if (RETIRED_GATE_TYPES.has(revision.request.gateType)) throw new Error("This legacy review is read-only.")
  const userId = await requireWorkspaceMember(revision.request.workspaceId)
  const decision = await recordDecision({
    actor: { kind: "USER", userId },
    revisionId: input.revisionId,
    fingerprint: input.fingerprint,
    optionId: input.optionId,
    rationale: input.rationale,
    idempotencyKey: `review:${input.revisionId}:${input.optionId}:${userId}`,
  })
  if (revision.request.gateType === "TRACKED_DECISION") {
    revalidatePath("/", "layout")
    return
  }
  const selected = await prisma.reviewOption.findUnique({ where: { id: input.optionId } })
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

// ─── Direction B — decisions produce work ─────────────────────────────────────

/**
 * Creates a Task from a decided decision and links it back in one step.
 * Membership is enough to act here: turning an answered decision into work is
 * follow-through, not a second authorization of the decision itself.
 */
export async function createFollowUpTaskAction(input: {
  workspaceId: string
  requestId: string
  title: string
  description: string
  assignee: TaskAssignee
}) {
  await requireWorkspaceMember(input.workspaceId)
  const result = await createDecisionFollowUpTask(input)
  revalidatePath("/", "layout")
  return result
}

/**
 * Records "this decision genuinely needs no work, and here is why", which is
 * the only honest way out of the awaiting-follow-through lens that isn't
 * creating a task.
 */
export async function closeDecisionNoActionAction(input: { workspaceId: string; requestId: string; reason: string }) {
  const userId = await requireWorkspaceMember(input.workspaceId)
  await recordDecisionNoAction({ ...input, actorUserId: userId })
  revalidatePath("/", "layout")
}
