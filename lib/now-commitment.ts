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
  description: string | null
  horizon: string
  status: string
  solutionId: string | null
  opportunityId: string | null
  squadId: string | null
  startDate: Date | null
  endDate: Date | null
  isPrivate: boolean
  sortOrder: number
  updatedAt: Date
  nowCommitmentProvenance?: string
}

export type NowCommitmentEligibilityInputs = {
  portfolioPolicyId: string
  investmentDecision: {
    authorityProvider: "OBSIDIAN" | "COMPASS"
    authorityRecordId: string
    authorityChecksum: string
    subjectId: string
    decisionOutcome: "APPROVE_BUILDING"
    applicationStatus: "APPLIED"
    applicationReceiptId: string
  }
  capacity: {
    planId: string
    planFingerprint: string
    unit: string
    availableUnits: number
    requestedUnits: number
    reservedUnits: number
    reservedRoadmapItemIds: string[]
    nowLimit: number
  }
  displacement?: { itemId: string; destination: "NEXT" | "LATER" }
}

export function nowCommitmentFingerprint(item: FingerprintItem, eligibility?: NowCommitmentEligibilityInputs): string {
  const canonical = JSON.stringify({
    gateType: "NOW_COMMITMENT",
    workspaceId: item.workspaceId,
    roadmapItemId: item.id,
    title: item.title,
    description: item.description,
    currentHorizon: item.horizon,
    status: item.status,
    solutionId: item.solutionId,
    opportunityId: item.opportunityId,
    ownerSquadId: item.squadId,
    startDate: item.startDate?.toISOString() ?? null,
    endDate: item.endDate?.toISOString() ?? null,
    isPrivate: item.isPrivate,
    sortOrder: item.sortOrder,
    requestedHorizon: "NOW",
    policyVersion: POLICY_VERSION,
    eligibility: eligibility ? {
      ...eligibility,
      capacity: { ...eligibility.capacity, reservedRoadmapItemIds: [...eligibility.capacity.reservedRoadmapItemIds].sort() },
    } : null,
    materialUpdatedAt: item.updatedAt.toISOString(),
  })
  return createHash("sha256").update(canonical).digest("hex")
}

function assertEligibilityConfigured(item: FingerprintItem, eligibility: NowCommitmentEligibilityInputs | undefined): asserts eligibility is NowCommitmentEligibilityInputs {
  if (!eligibility) throw new NowCommitmentError("POLICY_CONFIGURATION_REQUIRED", "NOW preparation is blocked until explicit investment, capacity, policy, and displacement inputs are configured.")
  if (!item.squadId) throw new NowCommitmentError("OWNER_REQUIRED", "An owning squad is required before NOW review.")
  if (!item.solutionId || eligibility.investmentDecision.subjectId !== item.solutionId) {
    throw new NowCommitmentError("NO_APPLIED_INVESTMENT_DECISION", "An applied Building investment decision for the exact Solution is required.")
  }
  const capacity = eligibility.capacity
  if (!eligibility.portfolioPolicyId || !capacity.planId || !capacity.planFingerprint || capacity.availableUnits <= 0 || capacity.requestedUnits <= 0 || capacity.nowLimit <= 0) {
    throw new NowCommitmentError("NO_CAPACITY_PLAN", "A complete explicit capacity plan is required.")
  }
  const effectiveLimit = Math.min(capacity.availableUnits, capacity.nowLimit)
  const overLimit = capacity.reservedUnits + capacity.requestedUnits > effectiveLimit
  if (overLimit && !eligibility.displacement) throw new NowCommitmentError("DISPLACEMENT_REQUIRED", "Capacity is full; an explicit displacement item and destination are required.")
  if (!overLimit && eligibility.displacement) throw new NowCommitmentError("INVALID_DISPLACEMENT", "Displacement is only valid when the configured capacity is full.")
}

export function decisionReviewFingerprint(requestId: string, decisionCycle: number, revisionNumber: number, sourceFingerprint: string): string {
  return createHash("sha256").update(`${requestId}:${decisionCycle}:${revisionNumber}:${sourceFingerprint}`).digest("hex")
}

const itemSelect = {
  id: true,
  workspaceId: true,
  title: true,
  description: true,
  horizon: true,
  status: true,
  solutionId: true,
  opportunityId: true,
  squadId: true,
  startDate: true,
  endDate: true,
  isPrivate: true,
  sortOrder: true,
  updatedAt: true,
  nowCommitmentProvenance: true,
} as const

export async function prepareNowCommitment(itemId: string, input: { requestedById?: string | null; eligibility?: NowCommitmentEligibilityInputs } = {}) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const item = await tx.roadmapItem.findUnique({ where: { id: itemId }, select: itemSelect })
    if (!item) throw new NowCommitmentError("ITEM_NOT_FOUND", "Roadmap item not found.")
    if (item.horizon === "NOW" && item.nowCommitmentProvenance !== "NATIVE_DECISION") {
      throw new NowCommitmentError("LEGACY_NOW", "Legacy NOW items cannot be retroactively approved.")
    }
    assertEligibilityConfigured(item, input.eligibility)
    const sourceFingerprint = nowCommitmentFingerprint(item, input.eligibility)
    const existing = await tx.reviewRequest.findFirst({
      where: { workspaceId: item.workspaceId, gateType: "NOW_COMMITMENT", subjectType: "ROADMAP_ITEM", subjectId: item.id },
      include: { currentRevision: true },
    })
    const currentSourceFingerprint = existing?.currentRevision?.sourceFingerprint ?? existing?.currentRevision?.fingerprint
    if (currentSourceFingerprint === sourceFingerprint && existing?.state === "PENDING" && existing.currentRevision) {
      return existing.currentRevision
    }
    if (currentSourceFingerprint === sourceFingerprint && existing?.state === "DECIDED") {
      throw new NowCommitmentError("DECISION_CYCLE_REQUIRED", "This source was already decided. Start an explicit new decision cycle to reconsider it.")
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
    const revisionNumber = existing ? existing.revisionCount + 1 : 1
    const decisionCycle = existing?.decisionCycle ?? 1
    const fingerprint = decisionReviewFingerprint(request.id, decisionCycle, revisionNumber, sourceFingerprint)
    const revision = await tx.reviewRevision.create({
      data: {
        requestId: request.id,
        revisionNumber,
        sourceFingerprint,
        fingerprint,
        title: `Commit ${item.title} to NOW`,
        summary: "Authorize this roadmap item to consume current delivery capacity.",
        packetJson: JSON.stringify({ policyVersion: POLICY_VERSION, sourceFingerprint, portfolioPolicyId: input.eligibility.portfolioPolicyId, investmentDecision: input.eligibility.investmentDecision, capacity: input.eligibility.capacity, displacement: input.eligibility.displacement ?? null, roadmapItem: item, requestedHorizon: "NOW" }),
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

export async function startNewNowCommitmentDecisionCycle(
  itemId: string,
  input: { reason: string; actorUserId: string; expectedTerminalDecisionId: string; eligibility?: NowCommitmentEligibilityInputs },
) {
  const reason = input.reason.trim()
  if (!reason) throw new NowCommitmentError("REOPEN_REASON_REQUIRED", "A reason is required to start a new decision cycle.")
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const item = await tx.roadmapItem.findUnique({ where: { id: itemId }, select: itemSelect })
    if (!item) throw new NowCommitmentError("ITEM_NOT_FOUND", "Roadmap item not found.")
    assertEligibilityConfigured(item, input.eligibility)
    const request = await tx.reviewRequest.findFirst({
      where: { workspaceId: item.workspaceId, gateType: "NOW_COMMITMENT", subjectType: "ROADMAP_ITEM", subjectId: item.id },
      include: { currentRevision: { include: { decisions: { include: { option: true } } } } },
    })
    const terminal = request?.currentRevision?.decisions[0]
    if (!request || request.state !== "DECIDED" || !terminal || terminal.id !== input.expectedTerminalDecisionId) {
      throw new NowCommitmentError("TERMINAL_DECISION_MISMATCH", "The expected terminal decision is no longer current.")
    }
    if (terminal.option.outcomeClass === "APPROVE") {
      throw new NowCommitmentError("APPROVAL_REQUIRES_REVOCATION", "An approval cannot be silently reopened; record an explicit revocation or correction.")
    }
    const sourceFingerprint = nowCommitmentFingerprint(item, input.eligibility)
    const decisionCycle = request.decisionCycle + 1
    const revisionNumber = request.revisionCount + 1
    const fingerprint = decisionReviewFingerprint(request.id, decisionCycle, revisionNumber, sourceFingerprint)
    await tx.reviewRevision.update({ where: { id: request.currentRevision!.id }, data: { supersededAt: new Date() } })
    const revision = await tx.reviewRevision.create({
      data: {
        requestId: request.id, revisionNumber, sourceFingerprint, fingerprint,
        title: `Commit ${item.title} to NOW`, summary: "Reconsider this roadmap item's authorization to consume current delivery capacity.",
        packetJson: JSON.stringify({ policyVersion: POLICY_VERSION, sourceFingerprint, portfolioPolicyId: input.eligibility.portfolioPolicyId, investmentDecision: input.eligibility.investmentDecision, capacity: input.eligibility.capacity, displacement: input.eligibility.displacement ?? null, roadmapItem: item, requestedHorizon: "NOW", reconsidersDecisionId: terminal.id, reopenReason: reason }),
        requiredRole: "ADMIN",
        options: { create: [
          { actionKey: "APPROVE_NOW", label: "Commit to NOW", outcomeClass: "APPROVE", continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW", sortOrder: 0 },
          { actionKey: "REJECT_NOW", label: "Keep out of NOW", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
          { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 2 },
        ] },
      },
    })
    await tx.reviewRequest.update({
      where: { id: request.id },
      data: { currentRevisionId: revision.id, state: "PENDING", revisionCount: revisionNumber, decisionCycle, reopenReason: reason, reopenedById: input.actorUserId, reconsidersDecisionId: terminal.id, updatedAt: new Date() },
    })
    return revision
  })
}

export async function ensureNowCommitmentRevisionFresh(revisionId: string) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const revision = await tx.reviewRevision.findUnique({ where: { id: revisionId }, include: { request: true } })
    if (!revision || revision.request.gateType !== "NOW_COMMITMENT") throw new NowCommitmentError("REVISION_NOT_FOUND", "NOW commitment revision not found.")
    if (revision.supersededAt) return { stale: true, sourceFingerprint: revision.sourceFingerprint ?? revision.fingerprint }
    const item = await tx.roadmapItem.findUnique({ where: { id: revision.request.subjectId }, select: itemSelect })
    if (!item) throw new NowCommitmentError("ITEM_NOT_FOUND", "Roadmap item not found.")
    const packet = JSON.parse(revision.packetJson) as {
      portfolioPolicyId?: string
      investmentDecision?: NowCommitmentEligibilityInputs["investmentDecision"]
      capacity?: NowCommitmentEligibilityInputs["capacity"]
      displacement?: NowCommitmentEligibilityInputs["displacement"] | null
    }
    const eligibility = packet.portfolioPolicyId && packet.investmentDecision && packet.capacity
      ? { portfolioPolicyId: packet.portfolioPolicyId, investmentDecision: packet.investmentDecision, capacity: packet.capacity, displacement: packet.displacement ?? undefined }
      : undefined
    const currentSourceFingerprint = nowCommitmentFingerprint(item, eligibility)
    const reviewedSourceFingerprint = revision.sourceFingerprint ?? revision.fingerprint
    if (currentSourceFingerprint === reviewedSourceFingerprint) return { stale: false, sourceFingerprint: currentSourceFingerprint }
    const now = new Date()
    await tx.reviewRevision.update({ where: { id: revision.id }, data: { supersededAt: now } })
    if (revision.request.currentRevisionId === revision.id) {
      await tx.reviewRequest.update({ where: { id: revision.request.id }, data: { state: "SUPERSEDED", updatedAt: now } })
    }
    return { stale: true, sourceFingerprint: currentSourceFingerprint }
  })
}

export async function admitRoadmapItemToNow(
  itemId: string,
  decisionId: string,
  dependencies: { fingerprint?: (item: FingerprintItem) => string } = {},
) {
  const prisma = getPrisma()
  const receiptKey = `now-commitment:${itemId}:${decisionId}:v1`
  try {
    return await prisma.$transaction(async (tx) => {
      const receipt = await tx.decisionApplication.findUnique({ where: { receiptKey } })
      if (receipt?.status === "APPLIED") return receipt
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
      const reviewedSourceFingerprint = decision.revision.sourceFingerprint ?? decision.revision.fingerprint
      if (decision.fingerprint !== decision.revision.fingerprint || reviewedSourceFingerprint !== currentFingerprint || decision.revision.supersededAt) {
        throw new NowCommitmentError("STALE_DECISION", "The roadmap commitment inputs changed after review.")
      }
      await tx.roadmapItem.update({
        where: { id: item.id },
        data: { horizon: "NOW", nowCommitmentProvenance: "NATIVE_DECISION", nowDecisionRecordId: decision.id, updatedAt: new Date() },
      })
      const applied = { status: "APPLIED", lastError: null, appliedAt: new Date(), updatedAt: new Date() }
      return receipt
        ? tx.decisionApplication.update({ where: { id: receipt.id }, data: { ...applied, attemptCount: { increment: 1 } } })
        : tx.decisionApplication.create({
            data: { decisionId: decision.id, continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW", targetType: "ROADMAP_ITEM", targetId: item.id, ...applied, receiptKey, attemptCount: 1 },
          })
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await prisma.decisionApplication.findUnique({ where: { receiptKey } })
      if (winner) return winner
    }
    if (error instanceof NowCommitmentError) {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.decisionApplication.findUnique({ where: { receiptKey } })
        if (existing?.status === "APPLIED") return existing
        const blocked = { status: "BLOCKED", lastError: error.message, updatedAt: new Date() }
        if (existing) return tx.decisionApplication.update({ where: { id: existing.id }, data: { ...blocked, attemptCount: { increment: 1 } } })
        try {
          return await tx.decisionApplication.create({
            data: { decisionId, continuationKey: "ADMIT_ROADMAP_ITEM_TO_NOW", targetType: "ROADMAP_ITEM", targetId: itemId, ...blocked, receiptKey, attemptCount: 1 },
          })
        } catch (receiptError) {
          if ((receiptError as { code?: string }).code !== "P2002") throw receiptError
          return tx.decisionApplication.findUnique({ where: { receiptKey } })
        }
      })
    }
    throw error
  }
}

export function assertDirectNowWriteBlocked(currentHorizon: string | null | undefined, requestedHorizon: string): void {
  if (requestedHorizon === "NOW" && currentHorizon !== "NOW") {
    throw new NowCommitmentError("DECISION_REQUIRED", "NOW admission requires a recorded commitment decision. Prepare and apply a NOW commitment review.")
  }
}
