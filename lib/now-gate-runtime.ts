import { randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import { deploymentNowGateMode } from "@/lib/now-gate-mode"
import { defaultNowEligibilityResolver, inspectConfiguredNowPolicy } from "@/lib/now-eligibility"
import { nowCommitmentFingerprint, NowCommitmentError } from "@/lib/now-commitment"

export type NowIngressActor = { kind: "USER" | "SERVICE" | "ANONYMOUS" | "SYSTEM"; id: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function initialHorizonForNowCreate(requestedHorizon: string, workspaceId: string): string {
  if (requestedHorizon !== "NOW") return requestedHorizon
  const deploymentMode = deploymentNowGateMode()
  if (deploymentMode === "off") return requestedHorizon
  if (deploymentMode === "shadow") return "NEXT"
  const configured = inspectConfiguredNowPolicy(workspaceId)
  if (!configured.runtimePolicyReady) throw new NowCommitmentError("POLICY_CONFIGURATION_REQUIRED", "A verified signed NOW policy is required before enforcement.")
  if (configured.effectiveMode === "shadow") return "NEXT"
  throw new NowCommitmentError("DECISION_REQUIRED", "NOW admission requires a recorded commitment decision. Create outside NOW, then prepare and apply a commitment review.")
}

export function requireEffectiveNowEnforcement(workspaceId: string): void {
  if (deploymentNowGateMode() !== "enforce") throw new Error("Native NOW decision reviews require effective enforce mode.")
  const policy = inspectConfiguredNowPolicy(workspaceId)
  if (!policy.runtimePolicyReady || policy.effectiveMode !== "enforce") throw new Error("Native NOW decision reviews require a verified enforce selector.")
}

const itemSelect = {
  id: true, workspaceId: true, title: true, description: true, horizon: true, status: true,
  solutionId: true, opportunityId: true, squadId: true, startDate: true, endDate: true,
  isPrivate: true, sortOrder: true, updatedAt: true, nowCommitmentProvenance: true,
} as const

export async function evaluateDirectNowIngress(input: {
  workspaceId: string; roadmapItemId: string; currentHorizon: string | null | undefined; requestedHorizon: string
  ingressKey: string; actor: NowIngressActor; correlationId?: string
}, database?: ReturnType<typeof getPrisma>, options: { telemetryFailure?: "report" | "throw" } = {}) {
  const deploymentMode = deploymentNowGateMode()
  if (input.requestedHorizon !== "NOW" || input.currentHorizon === "NOW" || deploymentMode === "off") return { mode: deploymentMode, outcome: null, evidenceIncomplete: false } as const
  if (!UUID.test(input.workspaceId)) throw new NowCommitmentError("WORKSPACE_INVALID", "NOW ingress workspace is invalid.")
  if (!UUID.test(input.roadmapItemId)) throw new NowCommitmentError("ITEM_INVALID", "NOW ingress roadmap item is invalid.")
  if (input.correlationId !== undefined && !UUID.test(input.correlationId)) throw new NowCommitmentError("CORRELATION_INVALID", "NOW ingress correlation is invalid.")
  if ((input.actor.kind === "USER" || input.actor.kind === "SERVICE") ? !input.actor.id || !UUID.test(input.actor.id) : input.actor.id !== null) {
    throw new NowCommitmentError("ACTOR_INVALID", "NOW ingress actor binding is invalid.")
  }
  if (!/^[a-z0-9_.:-]{1,64}$/i.test(input.ingressKey)) throw new NowCommitmentError("INGRESS_INVALID", "NOW ingress key is invalid.")
  const configured = inspectConfiguredNowPolicy(input.workspaceId)
  if (deploymentMode === "enforce" && !configured.runtimePolicyReady) throw new NowCommitmentError("POLICY_CONFIGURATION_REQUIRED", "A verified signed NOW policy is required before enforcement.")
  const mode = configured.runtimePolicyReady ? configured.effectiveMode : deploymentMode
  if (mode === "enforce") throw new NowCommitmentError("DECISION_REQUIRED", "NOW admission requires a recorded commitment decision. Prepare and apply a NOW commitment review.")
  const prisma = database ?? getPrisma()
  const item = await prisma.roadmapItem.findFirst({ where: { id: input.roadmapItemId, workspaceId: input.workspaceId }, select: itemSelect })
  if (!item) throw new NowCommitmentError("ITEM_NOT_FOUND", "Roadmap item not found.")
  let outcome: "WOULD_ALLOW" | "WOULD_BLOCK" = "WOULD_ALLOW", blockerCode: string | null = null
  const correlationId = input.correlationId ?? randomUUID()
  let policyArtifactId: string | null = null, routingFingerprint: string | null = null, capacityPlanId: string | null = null, capacityPlanFingerprint: string | null = null, sourceFingerprint: string | null = null
  try {
    const eligibility = await defaultNowEligibilityResolver.resolve(item, prisma)
    policyArtifactId = eligibility.policyEvidence?.artifactId ?? null
    routingFingerprint = eligibility.policyEvidence?.routingFingerprint ?? null
    capacityPlanId = eligibility.capacity.planId
    capacityPlanFingerprint = eligibility.capacity.planFingerprint
    sourceFingerprint = nowCommitmentFingerprint(item, eligibility)
  } catch (error) {
    outcome = "WOULD_BLOCK"
    blockerCode = typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code.slice(0, 80) : "PREFLIGHT_FAILED"
  }
  try {
    await prisma.nowGateEvaluation.create({ data: {
      workspaceId: input.workspaceId, roadmapItemId: item.id, ingressKey: input.ingressKey,
      mode: "SHADOW", outcome, blockerCode, policyArtifactId, routingFingerprint, capacityPlanId, capacityPlanFingerprint, sourceFingerprint,
      actorKind: input.actor.kind, actorId: input.actor.id, correlationId, createdAt: new Date(),
    } })
    return { mode, outcome, blockerCode, evidenceIncomplete: false }
  } catch (error) {
    if (options.telemetryFailure === "throw") throw error
    console.error("[now-gate-shadow] SHADOW_TELEMETRY_WRITE_FAILED", { correlationId })
    return { mode, outcome, blockerCode, evidenceIncomplete: true, operationalError: "SHADOW_TELEMETRY_WRITE_FAILED" as const }
  }
}

export async function createRoadmapItemWithNowGate<T extends { id: string; horizon: string }>(input: {
  workspaceId: string; requestedHorizon: string; ingressKey: string; actor: NowIngressActor
  create: (database: ReturnType<typeof getPrisma>, horizon: string) => Promise<T>
}): Promise<T> {
  const initialHorizon = initialHorizonForNowCreate(input.requestedHorizon, input.workspaceId)
  const prisma = getPrisma()
  if (initialHorizon === input.requestedHorizon) return input.create(prisma, initialHorizon)
  return prisma.$transaction(async (tx) => {
    const database = tx as unknown as ReturnType<typeof getPrisma>
    const item = await input.create(database, initialHorizon)
    await evaluateDirectNowIngress({ workspaceId: input.workspaceId, roadmapItemId: item.id, currentHorizon: item.horizon, requestedHorizon: input.requestedHorizon, ingressKey: input.ingressKey, actor: input.actor }, database, { telemetryFailure: "throw" })
    await database.roadmapItem.update({ where: { id: item.id }, data: { horizon: input.requestedHorizon, updatedAt: new Date() } })
    return { ...item, horizon: input.requestedHorizon }
  })
}

export async function transitionRoadmapItemWithNowGate<T>(input: {
  workspaceId: string; roadmapItemId: string; currentHorizon: string | null | undefined; requestedHorizon: string
  ingressKey: string; actor: NowIngressActor; mutate: (database: ReturnType<typeof getPrisma>) => Promise<T>
}): Promise<T> {
  if (input.requestedHorizon !== "NOW" || input.currentHorizon === "NOW" || deploymentNowGateMode() === "off") return input.mutate(getPrisma())
  return getPrisma().$transaction(async (tx) => {
    const database = tx as unknown as ReturnType<typeof getPrisma>
    const current = await database.roadmapItem.findFirst({ where: { id: input.roadmapItemId, workspaceId: input.workspaceId }, select: { horizon: true } })
    if (!current || current.horizon !== input.currentHorizon) throw new NowCommitmentError("ITEM_CONFLICT", "Roadmap item changed before NOW admission.")
    await evaluateDirectNowIngress({ ...input, currentHorizon: current.horizon }, database, { telemetryFailure: "throw" })
    return input.mutate(database)
  })
}

export async function finalizeCreatedNowIngress(input: Omit<Parameters<typeof evaluateDirectNowIngress>[0], "currentHorizon"> & { currentHorizon?: string | null }) {
  const currentHorizon = input.currentHorizon ?? initialHorizonForNowCreate(input.requestedHorizon, input.workspaceId)
  const result = await evaluateDirectNowIngress({ ...input, currentHorizon })
  if (currentHorizon !== input.requestedHorizon) {
    await getPrisma().roadmapItem.update({ where: { id: input.roadmapItemId }, data: { horizon: input.requestedHorizon, updatedAt: new Date() } })
  }
  return result
}
