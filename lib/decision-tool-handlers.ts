import getPrisma from "@/lib/db"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"
import { requireEffectiveNowEnforcement } from "@/lib/now-gate-runtime"
import { prepareReleaseRun, queueAuthorizedRelease, unconfiguredReleaseSourceRevalidator, type ReleaseScope } from "@/lib/release-authorization"
import { applyBuildingInvestmentDecision, applyBuildingInvestmentRevocationDecision, prepareBuildingInvestmentReview, prepareBuildingInvestmentRevocationReview, startNewBuildingInvestmentDecisionCycle } from "@/lib/building-investment"
import { generateNativeNowPolicy } from "@/lib/native-now-policy"
import { applyNativePolicyActivationDecision, prepareNativePolicyActivationReview } from "@/lib/native-policy-activation"

export async function requestNativePolicyActivation(input: { workspaceId: string; routingFingerprint?: string; mode: "shadow" | "enforce"; expectedTerminalDecisionId?: string; reason?: string }) {
  const actor = getMcpActor()
  try {
    const revision = await prepareNativePolicyActivationReview(input.workspaceId, { ...input, requestedById: actor.userId })
    return ok(`Native policy activation review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}`, revision)
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not prepare policy activation review.") }
}

export async function requestBuildingInvestment({ solutionId }: { solutionId: string }) {
  const actor = getMcpActor()
  try {
    const revision = await prepareBuildingInvestmentReview(solutionId, { requestedById: actor.userId })
    return ok(`Building investment review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}\nFingerprint: ${revision.fingerprint}`, revision)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare Building investment review.")
  }
}

export async function reconsiderBuildingInvestment({ solutionId, expectedTerminalDecisionId, reason }: { solutionId: string; expectedTerminalDecisionId: string; reason: string }) {
  const actor = getMcpActor()
  try {
    const revision = await startNewBuildingInvestmentDecisionCycle(solutionId, { expectedTerminalDecisionId, reason, actorUserId: actor.userId })
    return ok(`Building investment review reopened.\nID: ${revision.requestId}\nRevision ID: ${revision.id}`, revision)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not reconsider Building investment.")
  }
}

export async function requestBuildingInvestmentRevocation({ solutionId, authorityDecisionId }: { solutionId: string; authorityDecisionId: string }) {
  const actor = getMcpActor()
  try {
    const revision = await prepareBuildingInvestmentRevocationReview(solutionId, authorityDecisionId, { requestedById: actor.userId })
    return ok(`Building investment revocation review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}`, revision)
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not prepare Building investment revocation.") }
}

export async function inspectNativeNowPolicy({ workspaceId }: { workspaceId: string }) {
  try {
    const result = await generateNativeNowPolicy(workspaceId)
    return ok(`Native decision policy inputs verified.\nDecisions: ${result.inspection.verifiedDecisionCount}\nCapacity plan: ${result.inspection.capacityPlanId}`, result)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not inspect native decision policy.")
  }
}

export async function requestNowCommitment({ itemId }: { itemId: string }) {
  const actor = getMcpActor()
  try {
    const item = await getPrisma().roadmapItem.findUnique({ where: { id: itemId }, select: { workspaceId: true } })
    if (!item) return fail(`Roadmap item "${itemId}" not found.`)
    requireEffectiveNowEnforcement(item.workspaceId)
    const revision = await prepareNowCommitment(itemId, { requestedById: actor.userId })
    return ok(`NOW commitment review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}\nFingerprint: ${revision.fingerprint}`, revision)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare NOW commitment review.")
  }
}

export async function requestReleaseAuthorization(scope: ReleaseScope) {
  const actor = getMcpActor()
  try {
    const result = await prepareReleaseRun({ ...scope, requestedById: actor.userId })
    if (result.status === "BLOCKED") return fail(`Release authorization blocked: ${result.code}`)
    return ok(
      `Release authorization review prepared.\nID: ${result.requestId}\nRelease run: ${result.releaseRunId}\nRevision ID: ${result.revisionId}`,
      result,
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare release authorization review.")
  }
}

export async function getReviewRequest({ requestId }: { requestId: string }) {
  const request = await getPrisma().reviewRequest.findUnique({
    where: { id: requestId },
    include: { currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: true } } },
  })
  if (!request) return fail(`Review request "${requestId}" not found.`)
  return ok(`Review request ${request.id} [${request.state}]\nGate: ${request.gateType}\nSubject: ${request.subjectType} ${request.subjectId}`, request)
}

export async function listReviewRequests({ workspaceId, state }: { workspaceId: string; state?: string }) {
  const requests = await getPrisma().reviewRequest.findMany({
    where: { workspaceId, ...(state ? { state } : {}) },
    include: { currentRevision: { select: { title: true, fingerprint: true } } },
    orderBy: { updatedAt: "desc" },
  })
  return ok(requests.length ? requests.map((request) => `• ${request.currentRevision?.title ?? request.subjectId} [${request.state}] (${request.id})`).join("\n") : "No review requests found.", { requests })
}

export async function applyRecordedDecision({ decisionId }: { decisionId: string }) {
  const prisma = getPrisma()
  const decision = await prisma.decisionRecord.findUnique({ where: { id: decisionId }, include: { revision: { include: { request: true } } } })
  if (!decision) return fail(`Decision "${decisionId}" not found.`)
  try {
    if (decision.revision.request.gateType === "NOW_COMMITMENT") {
      requireEffectiveNowEnforcement(decision.revision.request.workspaceId)
      const receipt = await admitRoadmapItemToNow(decision.revision.request.subjectId, decision.id)
      return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
    }
    if (decision.revision.request.gateType === "BUILDING_INVESTMENT") {
      const receipt = await applyBuildingInvestmentDecision(decision.revision.request.subjectId, decision.id)
      return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
    }
    if (decision.revision.request.gateType === "BUILDING_INVESTMENT_REVOCATION") {
      const receipt = await applyBuildingInvestmentRevocationDecision(decision.revision.request.subjectId, decision.id)
      return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
    }
    if (decision.revision.request.gateType === "NOW_POLICY_ACTIVATION") {
      const receipt = await applyNativePolicyActivationDecision(decision.revision.request.workspaceId, decision.id)
      return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
    }
    if (decision.revision.request.gateType === "RELEASE_AUTHORIZATION" && decision.revision.sourceFingerprint) {
      const dispatch = await queueAuthorizedRelease(
        decision.revision.request.subjectId,
        decision.id,
        decision.revision.sourceFingerprint,
        unconfiguredReleaseSourceRevalidator,
      )
      if (dispatch.status === "BLOCKED") return fail(`Release dispatch blocked: ${dispatch.code}`)
      return ok(`Release dispatch recorded.\nID: ${dispatch.dispatchId}\nStatus: ${dispatch.status}`, dispatch)
    }
    return fail(`Decision gate "${decision.revision.request.gateType}" does not have an applicator.`)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not apply decision.")
  }
}
