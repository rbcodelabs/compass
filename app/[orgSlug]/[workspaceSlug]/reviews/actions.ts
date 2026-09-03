"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { recordDecision } from "@/lib/decision-service"
import { admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"
import { isOrgAdminRole } from "@/lib/roles"
import { queueAuthorizedRelease, unconfiguredReleaseSourceRevalidator } from "@/lib/release-authorization"
import { applyBuildingInvestmentDecision, applyBuildingInvestmentRevocationDecision, ensureBuildingInvestmentRevisionFresh, ensureBuildingInvestmentRevocationRevisionFresh, prepareBuildingInvestmentReview } from "@/lib/building-investment"
import { applyNativePolicyActivationDecision, ensureNativePolicyActivationRevisionFresh } from "@/lib/native-policy-activation"
import { requireEffectiveNowEnforcement } from "@/lib/now-gate-runtime"
import { createTrackedDecisionRequest, reviseTrackedDecisionRequest, type TrackedSubjectType } from "@/lib/tracked-decisions"

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
  requireEffectiveNowEnforcement(item.workspaceId)
  const userId = await requireWorkspaceMember(item.workspaceId)
  const revision = await prepareNowCommitment(itemId, { requestedById: userId })
  revalidatePath("/", "layout")
  return { requestId: revision.requestId, revisionId: revision.id }
}

export async function requestBuildingInvestmentAction(_workspaceId: string, solutionId: string) {
  const prisma = getPrisma()
  const solution = await prisma.solution.findUnique({ where: { id: solutionId }, select: { id: true, opportunity: { select: { workspaceId: true } } } })
  if (!solution) throw new Error("Solution not found")
  const userId = await requireWorkspaceMember(solution.opportunity.workspaceId)
  const revision = await prepareBuildingInvestmentReview(solutionId, { requestedById: userId })
  revalidatePath("/", "layout")
  return { requestId: revision.requestId, revisionId: revision.id }
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
  if (revision.request.gateType === "NOW_COMMITMENT") requireEffectiveNowEnforcement(revision.request.workspaceId)
  const userId = await requireWorkspaceMember(revision.request.workspaceId)
  const freshness = revision.request.gateType === "BUILDING_INVESTMENT"
    ? await ensureBuildingInvestmentRevisionFresh(revision.id)
    : revision.request.gateType === "BUILDING_INVESTMENT_REVOCATION"
      ? await ensureBuildingInvestmentRevocationRevisionFresh(revision.id)
    : revision.request.gateType === "NOW_POLICY_ACTIVATION"
      ? await ensureNativePolicyActivationRevisionFresh(revision.id)
      : { stale: false }
  if (freshness.stale) throw new Error("This review is stale. Prepare a new immutable revision before deciding.")
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
  if (selected?.continuationKey === "ADMIT_ROADMAP_ITEM_TO_NOW" && selected.outcomeClass === "APPROVE") {
    await admitRoadmapItemToNow(revision.request.subjectId, decision.id)
  }
  if (selected?.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT" && selected.outcomeClass === "APPROVE") {
    await applyBuildingInvestmentDecision(revision.request.subjectId, decision.id)
  }
  if (selected?.continuationKey === "REVOKE_BUILDING_INVESTMENT" && selected.outcomeClass === "APPROVE") {
    await applyBuildingInvestmentRevocationDecision(revision.request.subjectId, decision.id)
  }
  if (selected?.continuationKey === "AUTHORIZE_NOW_POLICY" && selected.outcomeClass === "APPROVE") {
    await applyNativePolicyActivationDecision(revision.request.workspaceId, decision.id)
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
