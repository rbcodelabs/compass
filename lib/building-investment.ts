import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"
import { investmentAuthorityChecksum } from "@/lib/native-decision-evidence"

export class BuildingInvestmentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "BuildingInvestmentError"
  }
}

type SolutionPacket = {
  id: string
  title: string
  description: string | null
  status: string
  updatedAt: Date
  opportunity: { id: string; title: string; workspaceId: string }
}

function exactAuthorityChecksum(authority: Parameters<typeof investmentAuthorityChecksum>[0] | null | undefined, receiptId: string): string | null {
  try { return authority ? investmentAuthorityChecksum(authority, receiptId) : null } catch { return null }
}

export function buildingInvestmentSourceFingerprint(solution: SolutionPacket): string {
  return createHash("sha256").update(JSON.stringify({
    gateType: "BUILDING_INVESTMENT",
    workspaceId: solution.opportunity.workspaceId,
    solutionId: solution.id,
    title: solution.title,
    description: solution.description,
    status: solution.status,
    opportunityId: solution.opportunity.id,
    opportunityTitle: solution.opportunity.title,
    materialUpdatedAt: solution.updatedAt.toISOString(),
  })).digest("hex")
}

function revisionFingerprint(requestId: string, cycle: number, revision: number, source: string): string {
  return createHash("sha256").update(`${requestId}:${cycle}:${revision}:${source}`).digest("hex")
}

const solutionSelect = {
  id: true, title: true, description: true, status: true, updatedAt: true,
  opportunity: { select: { id: true, title: true, workspaceId: true } },
} as const

export async function prepareBuildingInvestmentReview(solutionId: string, input: { requestedById?: string | null } = {}) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const solution = await tx.solution.findUnique({ where: { id: solutionId }, select: solutionSelect })
    if (!solution) throw new BuildingInvestmentError("SOLUTION_NOT_FOUND", "Solution not found.")
    const sourceFingerprint = buildingInvestmentSourceFingerprint(solution)
    const existing = await tx.reviewRequest.findFirst({
      where: { workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: solution.id },
      include: { currentRevision: true },
    })
    if (existing?.state === "PENDING" && existing.currentRevision?.sourceFingerprint === sourceFingerprint) return existing.currentRevision
    if (existing?.state === "DECIDED" && existing.currentRevision?.sourceFingerprint === sourceFingerprint) {
      throw new BuildingInvestmentError("DECISION_CYCLE_REQUIRED", "This investment source was already decided.")
    }
    if (existing?.currentRevisionId) await tx.reviewRevision.update({ where: { id: existing.currentRevisionId }, data: { supersededAt: new Date() } })
    const request = existing ?? await tx.reviewRequest.create({ data: {
      workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION",
      subjectId: solution.id, state: "DRAFT", requestedById: input.requestedById ?? null,
    } })
    const revisionNumber = existing ? existing.revisionCount + 1 : 1
    const cycle = existing?.decisionCycle ?? 1
    const revision = await tx.reviewRevision.create({ data: {
      requestId: request.id,
      revisionNumber,
      sourceFingerprint,
      fingerprint: revisionFingerprint(request.id, cycle, revisionNumber, sourceFingerprint),
      title: `Authorize Building investment in ${solution.title}`,
      summary: "Decide whether this Solution is authorized to receive delivery investment.",
      packetJson: JSON.stringify({ policyVersion: "building-investment-v1", sourceFingerprint, solution: {
        id: solution.id, title: solution.title, description: solution.description, status: solution.status,
        opportunityId: solution.opportunity.id, opportunityTitle: solution.opportunity.title,
      } }),
      requiredRole: "ADMIN",
      options: { create: [
        { actionKey: "APPROVE_BUILDING", label: "Approve Building investment", outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", sortOrder: 0 },
        { actionKey: "REJECT_BUILDING", label: "Do not invest", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
        { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 2 },
      ] },
    } })
    const update = { currentRevisionId: revision.id, state: "PENDING", revisionCount: revisionNumber, updatedAt: new Date() }
    if (existing) {
      const advanced = await tx.reviewRequest.updateMany({ where: { id: request.id, revisionCount: existing.revisionCount, currentRevisionId: existing.currentRevisionId }, data: update })
      if (advanced.count !== 1) throw new BuildingInvestmentError("PREPARATION_RACE", "Another investment review preparation won the race.")
    } else await tx.reviewRequest.update({ where: { id: request.id }, data: update })
    return revision
  })
}

export async function startNewBuildingInvestmentDecisionCycle(solutionId: string, input: { reason: string; actorUserId: string | null; expectedTerminalDecisionId: string }) {
  const reason = input.reason.trim()
  if (!reason) throw new BuildingInvestmentError("REOPEN_REASON_REQUIRED", "A reason is required to reconsider this investment decision.")
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const solution = await tx.solution.findUnique({ where: { id: solutionId }, select: solutionSelect })
    if (!solution) throw new BuildingInvestmentError("SOLUTION_NOT_FOUND", "Solution not found.")
    const request = await tx.reviewRequest.findFirst({
      where: { workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: solution.id },
      include: { currentRevision: { include: { decisions: { include: { revision: { include: { request: true, options: { select: { id: true } } } }, request: true, option: true, applications: true } } } } },
    })
    const terminal = request?.currentRevision?.decisions[0]
    if (!request || request.state !== "DECIDED" || !terminal || terminal.id !== input.expectedTerminalDecisionId) {
      throw new BuildingInvestmentError("TERMINAL_DECISION_MISMATCH", "The expected terminal investment decision is no longer current.")
    }
    if (terminal.option.outcomeClass === "APPROVE") {
      const authorityReceipt = terminal.applications.find((application) => application.status === "APPLIED"
        && application.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT" && application.targetType === "SOLUTION" && application.targetId === solutionId)
      const revocation = await tx.decisionRecord.findFirst({
        where: { workspaceId: solution.opportunity.workspaceId, revision: { request: { workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: solutionId }, supersededAt: null }, option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" }, applications: { some: { status: "APPLIED", continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: solutionId } } },
        include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true },
        orderBy: { decidedAt: "desc" },
      })
      const packet = revocation ? JSON.parse(revocation.revision.packetJson) as { authorityDecisionId?: string; authorityReceiptId?: string; authorityChecksum?: string; solution?: { id?: string } } : {}
      const revocationReceipt = revocation?.applications.find((application) => application.status === "APPLIED"
        && application.continuationKey === "REVOKE_BUILDING_INVESTMENT" && application.targetType === "SOLUTION" && application.targetId === solutionId)
      if (!authorityReceipt || !revocation || packet.authorityDecisionId !== terminal.id || packet.authorityReceiptId !== authorityReceipt.id
        || packet.solution?.id !== solutionId || revocation.workspaceId !== solution.opportunity.workspaceId
        || revocation.requestId !== revocation.revision.request.id || revocation.request.id !== revocation.requestId
        || revocation.request.state !== "DECIDED" || revocation.request.currentRevisionId !== revocation.revisionId
        || revocation.fingerprint !== revocation.revision.fingerprint || !revocation.revision.options.some((option) => option.id === revocation.optionId)
        || revocation.option.outcomeClass !== "APPROVE" || revocation.option.continuationKey !== "REVOKE_BUILDING_INVESTMENT"
        || !revocationReceipt || !packet.authorityChecksum || packet.authorityChecksum !== exactAuthorityChecksum(terminal, authorityReceipt.id)
        || revocation.revision.sourceFingerprint !== buildingRevocationSourceFingerprint(solution, terminal.id, authorityReceipt.id, packet.authorityChecksum)) {
        throw new BuildingInvestmentError("APPROVAL_REQUIRES_REVOCATION", "An approved investment requires an exact applied revocation before reconsideration.")
      }
    }
    const sourceFingerprint = buildingInvestmentSourceFingerprint(solution)
    const revisionNumber = request.revisionCount + 1
    const decisionCycle = request.decisionCycle + 1
    await tx.reviewRevision.update({ where: { id: request.currentRevision!.id }, data: { supersededAt: new Date() } })
    const revision = await tx.reviewRevision.create({ data: {
      requestId: request.id, revisionNumber, sourceFingerprint,
      fingerprint: revisionFingerprint(request.id, decisionCycle, revisionNumber, sourceFingerprint),
      title: `Authorize Building investment in ${solution.title}`,
      summary: "Reconsider whether this Solution is authorized to receive delivery investment.",
      packetJson: JSON.stringify({ policyVersion: "building-investment-v1", sourceFingerprint, solution: { id: solution.id, title: solution.title, description: solution.description, status: solution.status, opportunityId: solution.opportunity.id, opportunityTitle: solution.opportunity.title }, reconsidersDecisionId: terminal.id, reopenReason: reason }),
      requiredRole: "ADMIN",
      options: { create: [
        { actionKey: "APPROVE_BUILDING", label: "Approve Building investment", outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", sortOrder: 0 },
        { actionKey: "REJECT_BUILDING", label: "Do not invest", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
        { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 2 },
      ] },
    } })
    await tx.reviewRequest.update({ where: { id: request.id }, data: { currentRevisionId: revision.id, state: "PENDING", revisionCount: revisionNumber, decisionCycle, reopenReason: reason, reopenedById: input.actorUserId, reconsidersDecisionId: terminal.id, updatedAt: new Date() } })
    return revision
  })
}

export async function ensureBuildingInvestmentRevisionFresh(revisionId: string) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const revision = await tx.reviewRevision.findUnique({ where: { id: revisionId }, include: { request: true } })
    if (!revision || revision.request.gateType !== "BUILDING_INVESTMENT") throw new BuildingInvestmentError("REVISION_NOT_FOUND", "Building investment revision not found.")
    if (revision.supersededAt) return { stale: true }
    if (revision.request.state === "DECIDED") return { stale: false }
    const solution = await tx.solution.findUnique({ where: { id: revision.request.subjectId }, select: solutionSelect })
    const current = solution ? buildingInvestmentSourceFingerprint(solution) : null
    if (current && current === revision.sourceFingerprint) return { stale: false }
    const now = new Date()
    await tx.reviewRevision.update({ where: { id: revision.id }, data: { supersededAt: now } })
    if (revision.request.currentRevisionId === revision.id) await tx.reviewRequest.update({ where: { id: revision.request.id }, data: { state: "SUPERSEDED", updatedAt: now } })
    return { stale: true }
  })
}

export async function applyBuildingInvestmentDecision(solutionId: string, decisionId: string) {
  const prisma = getPrisma()
  const receiptKey = `building-investment:${solutionId}:${decisionId}:v1`
  try {
    return await prisma.$transaction(async (tx) => {
      const replay = await tx.decisionApplication.findUnique({ where: { receiptKey } })
      if (replay) {
        if (replay.decisionId !== decisionId || replay.targetId !== solutionId || replay.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT" || replay.targetType !== "SOLUTION" || replay.status !== "APPLIED") {
          throw new BuildingInvestmentError("RECEIPT_CONFLICT", "The authorization receipt does not match this decision.")
        }
        return replay
      }
      const solution = await tx.solution.findUnique({ where: { id: solutionId }, select: solutionSelect })
      if (!solution) throw new BuildingInvestmentError("SOLUTION_NOT_FOUND", "Solution not found.")
      const decision = await tx.decisionRecord.findUnique({
        where: { id: decisionId },
        include: { revision: { include: { request: true, options: { select: { id: true } } } }, option: true, request: true },
      })
      const request = decision?.revision.request
      const selectedBelongsToRevision = Boolean(decision?.revision.options.some((option) => option.id === decision.optionId))
      if (!decision || !request || decision.requestId !== request.id || decision.request.id !== decision.requestId
        || decision.workspaceId !== solution.opportunity.workspaceId || request.workspaceId !== solution.opportunity.workspaceId
        || decision.request.state !== "DECIDED" || decision.request.currentRevisionId !== decision.revisionId
        || request.gateType !== "BUILDING_INVESTMENT" || request.subjectType !== "SOLUTION" || request.subjectId !== solution.id
        || decision.revision.sourceFingerprint !== buildingInvestmentSourceFingerprint(solution)
        || decision.fingerprint !== decision.revision.fingerprint || decision.revision.supersededAt || !selectedBelongsToRevision
        || decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT") {
        throw new BuildingInvestmentError("DECISION_MISMATCH", "Decision is not a current approved Building investment for this Solution.")
      }
      return tx.decisionApplication.create({ data: {
        decisionId, continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: solutionId,
        status: "APPLIED", receiptKey, attemptCount: 1, appliedAt: new Date(), updatedAt: new Date(),
      } })
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await prisma.decisionApplication.findUnique({ where: { receiptKey } })
      if (winner?.decisionId === decisionId && winner.targetId === solutionId && winner.status === "APPLIED"
        && winner.targetType === "SOLUTION" && winner.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT") return winner
      throw new BuildingInvestmentError("RECEIPT_CONFLICT", "A concurrent authorization receipt does not match this decision.")
    }
    throw error
  }
}

function buildingRevocationSourceFingerprint(solution: SolutionPacket, authorityDecisionId: string, authorityReceiptId: string, authorityChecksum: string) {
  return createHash("sha256").update(JSON.stringify({ gateType: "BUILDING_INVESTMENT_REVOCATION", solutionSourceFingerprint: buildingInvestmentSourceFingerprint(solution), authorityDecisionId, authorityReceiptId, authorityChecksum })).digest("hex")
}

export async function prepareBuildingInvestmentRevocationReview(solutionId: string, authorityDecisionId: string, input: { requestedById?: string | null } = {}) {
  const prisma = getPrisma()
  return prisma.$transaction(async (tx) => {
    const solution = await tx.solution.findUnique({ where: { id: solutionId }, select: solutionSelect })
    const authority = await tx.decisionRecord.findUnique({ where: { id: authorityDecisionId }, include: { revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true } })
    const receipt = authority?.applications.find((candidate) => candidate.status === "APPLIED" && candidate.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT" && candidate.targetType === "SOLUTION" && candidate.targetId === solutionId)
    if (!solution || !authority || authority.workspaceId !== solution.opportunity.workspaceId || authority.revision.request.gateType !== "BUILDING_INVESTMENT"
      || authority.revision.request.subjectId !== solutionId || authority.option.outcomeClass !== "APPROVE" || !receipt) {
      throw new BuildingInvestmentError("AUTHORITY_NOT_FOUND", "A current applied Building investment authority is required for revocation.")
    }
    const authorityChecksum = exactAuthorityChecksum(authority, receipt.id)
    if (!authorityChecksum) throw new BuildingInvestmentError("AUTHORITY_NOT_FOUND", "The Building investment authority evidence is incomplete.")
    const sourceFingerprint = buildingRevocationSourceFingerprint(solution, authority.id, receipt.id, authorityChecksum)
    const existing = await tx.reviewRequest.findFirst({ where: { workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: solutionId }, include: { currentRevision: true } })
    if (existing?.state === "PENDING" && existing.currentRevision?.sourceFingerprint === sourceFingerprint) return existing.currentRevision
    if (existing?.state === "DECIDED") throw new BuildingInvestmentError("REVOCATION_CYCLE_REQUIRED", "This revocation was already decided; start an explicit correction cycle.")
    if (existing?.currentRevisionId) await tx.reviewRevision.update({ where: { id: existing.currentRevisionId }, data: { supersededAt: new Date() } })
    const request = existing ?? await tx.reviewRequest.create({ data: { workspaceId: solution.opportunity.workspaceId, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: solutionId, state: "DRAFT", requestedById: input.requestedById ?? null } })
    const revisionNumber = existing ? existing.revisionCount + 1 : 1
    const revision = await tx.reviewRevision.create({ data: { requestId: request.id, revisionNumber, sourceFingerprint, fingerprint: revisionFingerprint(request.id, existing?.decisionCycle ?? 1, revisionNumber, sourceFingerprint), title: `Revoke Building investment in ${solution.title}`, summary: "Correct or revoke the applied Building investment authority while preserving its history.", packetJson: JSON.stringify({ policyVersion: "building-investment-revocation-v1", sourceFingerprint, solution: { id: solution.id, title: solution.title, status: solution.status, opportunityId: solution.opportunity.id, opportunityTitle: solution.opportunity.title }, authorityDecisionId: authority.id, authorityReceiptId: receipt.id, authorityChecksum }), requiredRole: "ADMIN", options: { create: [
      { actionKey: "REVOKE_BUILDING", label: "Revoke Building investment", outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT", sortOrder: 0 },
      { actionKey: "KEEP_BUILDING", label: "Keep Building investment", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
    ] } } })
    await tx.reviewRequest.update({ where: { id: request.id }, data: { currentRevisionId: revision.id, state: "PENDING", revisionCount: revisionNumber, updatedAt: new Date() } })
    return revision
  })
}

export async function applyBuildingInvestmentRevocationDecision(solutionId: string, decisionId: string) {
  const prisma = getPrisma(), receiptKey = `building-investment-revocation:${solutionId}:${decisionId}:v1`
  try {
    return await prisma.$transaction(async (tx) => {
      const replay = await tx.decisionApplication.findUnique({ where: { receiptKey } })
      if (replay) {
        if (replay.decisionId === decisionId && replay.targetId === solutionId && replay.targetType === "SOLUTION" && replay.continuationKey === "REVOKE_BUILDING_INVESTMENT" && replay.status === "APPLIED") return replay
        throw new BuildingInvestmentError("RECEIPT_CONFLICT", "Revocation receipt does not match this decision.")
      }
      const solution = await tx.solution.findUnique({ where: { id: solutionId }, select: solutionSelect })
      const decision = await tx.decisionRecord.findUnique({ where: { id: decisionId }, include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true } })
      const packet = decision ? JSON.parse(decision.revision.packetJson) as { authorityDecisionId?: string; authorityReceiptId?: string; authorityChecksum?: string } : {}
      const authority = packet.authorityDecisionId ? await tx.decisionRecord.findUnique({ where: { id: packet.authorityDecisionId }, include: { revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true } }) : null
      const authorityReceipt = authority?.applications.find((candidate) => candidate.id === packet.authorityReceiptId && candidate.status === "APPLIED" && candidate.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT" && candidate.targetId === solutionId)
      if (!solution || !decision || decision.requestId !== decision.revision.request.id || decision.request.id !== decision.requestId || decision.workspaceId !== solution.opportunity.workspaceId
        || decision.request.state !== "DECIDED" || decision.request.currentRevisionId !== decision.revisionId || decision.revision.request.gateType !== "BUILDING_INVESTMENT_REVOCATION"
        || decision.revision.request.subjectType !== "SOLUTION" || decision.revision.request.subjectId !== solutionId || decision.revision.supersededAt
        || !decision.revision.options.some((option) => option.id === decision.optionId) || decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== "REVOKE_BUILDING_INVESTMENT"
        || !packet.authorityDecisionId || !packet.authorityReceiptId || !packet.authorityChecksum || !authorityReceipt
        || packet.authorityChecksum !== exactAuthorityChecksum(authority, authorityReceipt.id)
        || decision.revision.sourceFingerprint !== buildingRevocationSourceFingerprint(solution, packet.authorityDecisionId, packet.authorityReceiptId, packet.authorityChecksum)) {
        throw new BuildingInvestmentError("DECISION_MISMATCH", "Decision does not revoke the exact current Building authority.")
      }
      return tx.decisionApplication.create({ data: { decisionId, continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: solutionId, status: "APPLIED", receiptKey, attemptCount: 1, appliedAt: new Date(), updatedAt: new Date() } })
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await prisma.decisionApplication.findUnique({ where: { receiptKey } })
      if (winner?.decisionId === decisionId && winner.targetId === solutionId && winner.targetType === "SOLUTION" && winner.continuationKey === "REVOKE_BUILDING_INVESTMENT" && winner.status === "APPLIED") return winner
      throw new BuildingInvestmentError("RECEIPT_CONFLICT", "Concurrent revocation receipt does not match.")
    }
    throw error
  }
}

export async function ensureBuildingInvestmentRevocationRevisionFresh(revisionId: string) {
  const prisma = getPrisma()
  const revision = await prisma.reviewRevision.findUnique({ where: { id: revisionId }, include: { request: true } })
  if (!revision || revision.request.gateType !== "BUILDING_INVESTMENT_REVOCATION") throw new BuildingInvestmentError("REVISION_NOT_FOUND", "Building revocation revision not found.")
  if (revision.supersededAt) return { stale: true }
  if (revision.request.state === "DECIDED") return { stale: false }
  const packet = JSON.parse(revision.packetJson) as { authorityDecisionId?: string; authorityReceiptId?: string; authorityChecksum?: string }
  const solution = await prisma.solution.findUnique({ where: { id: revision.request.subjectId }, select: solutionSelect })
  const authority = packet.authorityDecisionId ? await prisma.decisionRecord.findUnique({ where: { id: packet.authorityDecisionId }, include: { revision: { include: { request: true } }, option: true, applications: true } }) : null
  const receipt = authority?.applications.find((candidate) => candidate.id === packet.authorityReceiptId && candidate.status === "APPLIED" && candidate.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT" && candidate.targetId === revision.request.subjectId)
  const current = solution && packet.authorityDecisionId && packet.authorityChecksum && receipt && packet.authorityChecksum === exactAuthorityChecksum(authority, receipt.id) ? buildingRevocationSourceFingerprint(solution, packet.authorityDecisionId, receipt.id, packet.authorityChecksum) : null
  if (current === revision.sourceFingerprint) return { stale: false }
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.reviewRevision.update({ where: { id: revision.id }, data: { supersededAt: now } })
    if (revision.request.currentRevisionId === revision.id) await tx.reviewRequest.update({ where: { id: revision.request.id }, data: { state: "SUPERSEDED", updatedAt: now } })
  })
  return { stale: true }
}
