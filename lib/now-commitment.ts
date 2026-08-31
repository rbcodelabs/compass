import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"

const POLICY_VERSION = "now-commitment-v1"

export class NowCommitmentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "NowCommitmentError"
  }
}

type FingerprintItem = {
  id: string
  workspaceId: string
  title: string
  horizon: string
  solutionId: string | null
  opportunityId: string | null
  squadId: string | null
  updatedAt: Date
  nowCommitmentProvenance?: string
}

export function nowCommitmentFingerprint(item: FingerprintItem): string {
  const canonical = JSON.stringify({
    gateType: "NOW_COMMITMENT",
    workspaceId: item.workspaceId,
    roadmapItemId: item.id,
    solutionId: item.solutionId,
    opportunityId: item.opportunityId,
    ownerSquadId: item.squadId,
    requestedHorizon: "NOW",
    policyVersion: POLICY_VERSION,
    materialUpdatedAt: item.updatedAt.toISOString(),
  })
  return createHash("sha256").update(canonical).digest("hex")
}

const itemSelect = {
  id: true,
  workspaceId: true,
  title: true,
  horizon: true,
  solutionId: true,
  opportunityId: true,
  squadId: true,
  updatedAt: true,
  nowCommitmentProvenance: true,
} as const

export async function prepareNowCommitment(itemId: string, input: { requestedById?: string | null } = {}) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const item = await tx.roadmapItem.findUnique({ where: { id: itemId }, select: itemSelect })
    if (!item) throw new NowCommitmentError("ITEM_NOT_FOUND", "Roadmap item not found.")
    if (item.horizon === "NOW" && item.nowCommitmentProvenance !== "NATIVE_DECISION") {
      throw new NowCommitmentError("LEGACY_NOW", "Legacy NOW items cannot be retroactively approved.")
    }
    const fingerprint = nowCommitmentFingerprint(item)
    const existing = await tx.reviewRequest.findFirst({
      where: { workspaceId: item.workspaceId, gateType: "NOW_COMMITMENT", subjectType: "ROADMAP_ITEM", subjectId: item.id },
      include: { currentRevision: true },
    })
    if (existing?.currentRevision?.fingerprint === fingerprint && existing.state === "PENDING") {
      return existing.currentRevision
    }
    if (existing?.currentRevisionId) {
      await tx.reviewRevision.update({ where: { id: existing.currentRevisionId }, data: { supersededAt: new Date() } })
    }
    const request = existing ?? await tx.reviewRequest.create({
      data: {
        workspaceId: item.workspaceId,
        gateType: "NOW_COMMITMENT",
        subjectType: "ROADMAP_ITEM",
        subjectId: item.id,
        state: "DRAFT",
        requestedById: input.requestedById ?? null,
      },
    })
    const revision = await tx.reviewRevision.create({
      data: {
        requestId: request.id,
        revisionNumber: existing ? existing.revisionCount + 1 : 1,
        fingerprint,
        title: `Commit ${item.title} to NOW`,
        summary: "Authorize this roadmap item to consume current delivery capacity.",
        packetJson: JSON.stringify({ policyVersion: POLICY_VERSION, roadmapItem: item, requestedHorizon: "NOW" }),
        requiredRole: "ADMIN",
        options: {
          create: [
            { actionKey: "APPROVE_NOW", label: "Commit to NOW", outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW", sortOrder: 0 },
            { actionKey: "REJECT_NOW", label: "Keep out of NOW", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
            { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 2 },
          ],
        },
      },
    })
    await tx.reviewRequest.update({
      where: { id: request.id },
      data: { currentRevisionId: revision.id, state: "PENDING", revisionCount: existing ? existing.revisionCount + 1 : 1, updatedAt: new Date() },
    })
    return revision
  })
}

export async function admitRoadmapItemToNow(
  itemId: string,
  decisionId: string,
  dependencies: { fingerprint?: (item: FingerprintItem) => string } = {},
) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const receiptKey = `now-commitment:${itemId}:${decisionId}:v1`
    const replay = await tx.decisionApplication.findUnique({ where: { receiptKey } })
    if (replay) return replay
    const item = await tx.roadmapItem.findUnique({ where: { id: itemId }, select: itemSelect })
    if (!item) throw new NowCommitmentError("ITEM_NOT_FOUND", "Roadmap item not found.")
    const decision = await tx.decisionRecord.findUnique({
      where: { id: decisionId },
      include: { revision: { include: { request: true } }, option: true },
    })
    if (!decision || decision.revision.request.gateType !== "NOW_COMMITMENT" || decision.revision.request.subjectId !== item.id || decision.revision.request.workspaceId !== item.workspaceId) {
      throw new NowCommitmentError("DECISION_MISMATCH", "A matching NOW commitment decision is required.")
    }
    if (decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== "ADMIT_ROADMAP_ITEM_TO_NOW") {
      throw new NowCommitmentError("NOT_APPROVED", "This decision does not authorize NOW admission.")
    }
    const currentFingerprint = (dependencies.fingerprint ?? nowCommitmentFingerprint)(item)
    if (decision.fingerprint !== currentFingerprint || decision.revision.fingerprint !== currentFingerprint || decision.revision.supersededAt) {
      throw new NowCommitmentError("STALE_DECISION", "The roadmap commitment inputs changed after review.")
    }
    await tx.roadmapItem.update({
      where: { id: item.id },
      data: { horizon: "NOW", nowCommitmentProvenance: "NATIVE_DECISION", nowDecisionRecordId: decision.id, updatedAt: new Date() },
    })
    return tx.decisionApplication.create({
      data: { decisionId: decision.id, continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW", targetType: "ROADMAP_ITEM", targetId: item.id, status: "APPLIED", receiptKey, attemptCount: 1, appliedAt: new Date() },
    })
  })
}

export function assertDirectNowWriteBlocked(currentHorizon: string | null | undefined, requestedHorizon: string): void {
  if (requestedHorizon === "NOW" && currentHorizon !== "NOW") {
    throw new NowCommitmentError("DECISION_REQUIRED", "NOW admission requires a recorded commitment decision. Prepare and apply a NOW commitment review.")
  }
}
