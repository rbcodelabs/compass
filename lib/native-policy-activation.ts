import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"
import { generateNativeNowPolicy, nativePolicyCandidateFingerprint } from "@/lib/native-now-policy"
import { configuredDecisionRouting } from "@/lib/decision-routing"

export class NativePolicyActivationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "NativePolicyActivationError" }
}

export async function prepareNativePolicyActivationReview(workspaceId: string, input: { routingFingerprint?: string; mode: "shadow" | "enforce"; requestedById?: string | null; expectedTerminalDecisionId?: string; reason?: string }) {
  const routingFingerprint = configuredDecisionRouting().fingerprint
  if (input.routingFingerprint && input.routingFingerprint !== routingFingerprint) throw new NativePolicyActivationError("ROUTING_FINGERPRINT_MISMATCH", "The asserted routing fingerprint does not match canonical routing.")
  const prisma = getPrisma()
  const generated = await generateNativeNowPolicy(workspaceId, prisma)
  const sourceFingerprint = nativePolicyCandidateFingerprint(generated, routingFingerprint, input.mode)
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reviewRequest.findFirst({ where: { workspaceId, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: workspaceId }, include: { currentRevision: { include: { decisions: { select: { id: true } } } } } })
    if (existing?.state === "PENDING" && existing.currentRevision?.sourceFingerprint === sourceFingerprint) return existing.currentRevision
    if (existing?.state === "PENDING") throw new NativePolicyActivationError("PENDING_ACTIVATION_EXISTS", "Resolve the current activation review before preparing another.")
    let terminalDecisionId: string | undefined
    if (existing) {
      terminalDecisionId = existing.currentRevision?.decisions[0]?.id
      if (!input.reason?.trim() || !terminalDecisionId || terminalDecisionId !== input.expectedTerminalDecisionId) throw new NativePolicyActivationError("ACTIVATION_CYCLE_REQUIRED", "The current terminal decision ID and a reason are required to supersede an activation.")
      if (existing.currentRevisionId) await tx.reviewRevision.update({ where: { id: existing.currentRevisionId }, data: { supersededAt: new Date() } })
    }
    const request = existing ?? await tx.reviewRequest.create({ data: { workspaceId, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: workspaceId, state: "DRAFT", requestedById: input.requestedById ?? null } })
    const revisionNumber = existing ? existing.revisionCount + 1 : 1
    const decisionCycle = existing ? existing.decisionCycle + 1 : 1
    const fingerprint = createHash("sha256").update(`${request.id}:${decisionCycle}:${revisionNumber}:${sourceFingerprint}`).digest("hex")
    const revision = await tx.reviewRevision.create({ data: {
      requestId: request.id, revisionNumber, sourceFingerprint, fingerprint,
      title: `Activate Compass-native NOW policy for workspace ${workspaceId}`,
      summary: `Authorize the exact generated policy candidate in ${input.mode} mode.`,
      packetJson: JSON.stringify({ policyVersion: "compass-now-policy/v1", workspaceId, routingFingerprint, mode: input.mode, sourceFingerprint, inspection: generated.inspection, document: generated.document }),
      requiredRole: "ADMIN", options: { create: [
        { actionKey: "APPROVE_POLICY", label: "Approve policy activation", outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY", sortOrder: 0 },
        { actionKey: "REJECT_POLICY", label: "Do not activate", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
      ] },
    } })
    await tx.reviewRequest.update({ where: { id: request.id }, data: { currentRevisionId: revision.id, state: "PENDING", revisionCount: revisionNumber, decisionCycle, ...(existing ? { reopenReason: input.reason!.trim(), reopenedById: input.requestedById ?? null, reconsidersDecisionId: terminalDecisionId } : {}), updatedAt: new Date() } })
    return revision
  })
}

export async function applyNativePolicyActivationDecision(workspaceId: string, decisionId: string) {
  const prisma = getPrisma(); const receiptKey = `now-policy-activation:${workspaceId}:${decisionId}:v1`
  try { return await prisma.$transaction(async (tx) => {
    const replay = await tx.decisionApplication.findUnique({ where: { receiptKey } })
    if (replay) {
      if (replay.decisionId === decisionId && replay.targetId === workspaceId && replay.targetType === "WORKSPACE" && replay.continuationKey === "AUTHORIZE_NOW_POLICY" && replay.status === "APPLIED") return replay
      throw new NativePolicyActivationError("RECEIPT_CONFLICT", "Policy activation receipt does not match.")
    }
    const decision = await tx.decisionRecord.findUnique({ where: { id: decisionId }, include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true } })
    const request = decision?.revision.request
    const packet = decision ? JSON.parse(decision.revision.packetJson) as { routingFingerprint?: string; mode?: "shadow" | "enforce" } : {}
    let currentSource: string | null = null
    try {
      const routingFingerprint = configuredDecisionRouting().fingerprint
      if (packet.routingFingerprint === routingFingerprint && packet.mode) currentSource = nativePolicyCandidateFingerprint(await generateNativeNowPolicy(workspaceId, tx as ReturnType<typeof getPrisma>), routingFingerprint, packet.mode)
    } catch { currentSource = null }
    if (!decision || !request || decision.requestId !== request.id || decision.request.id !== decision.requestId
      || decision.workspaceId !== workspaceId || request.workspaceId !== workspaceId || request.gateType !== "NOW_POLICY_ACTIVATION"
      || request.subjectType !== "WORKSPACE" || request.subjectId !== workspaceId || decision.request.state !== "DECIDED" || decision.request.currentRevisionId !== decision.revisionId
      || decision.revision.supersededAt || decision.fingerprint !== decision.revision.fingerprint || !currentSource || currentSource !== decision.revision.sourceFingerprint
      || !decision.revision.options.some((option) => option.id === decision.optionId)
      || decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== "AUTHORIZE_NOW_POLICY") {
      throw new NativePolicyActivationError("DECISION_MISMATCH", "Decision does not authorize this exact policy activation.")
    }
    return tx.decisionApplication.create({ data: { decisionId, continuationKey: "AUTHORIZE_NOW_POLICY", targetType: "WORKSPACE", targetId: workspaceId, status: "APPLIED", receiptKey, attemptCount: 1, appliedAt: new Date(), updatedAt: new Date() } })
  }) } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await prisma.decisionApplication.findUnique({ where: { receiptKey } })
      if (winner?.decisionId === decisionId && winner.targetId === workspaceId && winner.targetType === "WORKSPACE" && winner.continuationKey === "AUTHORIZE_NOW_POLICY" && winner.status === "APPLIED") return winner
      throw new NativePolicyActivationError("RECEIPT_CONFLICT", "A concurrent policy activation receipt does not match.")
    }
    throw error
  }
}

export async function ensureNativePolicyActivationRevisionFresh(revisionId: string) {
  const prisma = getPrisma()
  const revision = await prisma.reviewRevision.findUnique({ where: { id: revisionId }, include: { request: true } })
  if (!revision || revision.request.gateType !== "NOW_POLICY_ACTIVATION") throw new NativePolicyActivationError("REVISION_NOT_FOUND", "Policy activation revision not found.")
  if (revision.supersededAt) return { stale: true }
  if (revision.request.state === "DECIDED") return { stale: false }
  const packet = JSON.parse(revision.packetJson) as { routingFingerprint?: string; mode?: "shadow" | "enforce" }
  let current: string | null = null
  try {
    const routingFingerprint = configuredDecisionRouting().fingerprint
    if (packet.routingFingerprint === routingFingerprint && packet.mode) current = nativePolicyCandidateFingerprint(await generateNativeNowPolicy(revision.request.workspaceId, prisma), routingFingerprint, packet.mode)
  } catch { current = null }
  if (current && current === revision.sourceFingerprint) return { stale: false }
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.reviewRevision.update({ where: { id: revision.id }, data: { supersededAt: now } })
    if (revision.request.currentRevisionId === revision.id) await tx.reviewRequest.update({ where: { id: revision.request.id }, data: { state: "SUPERSEDED", updatedAt: now } })
  })
  return { stale: true }
}
