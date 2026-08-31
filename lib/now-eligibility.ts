import getPrisma from "@/lib/db"
import type { NowCommitmentEligibilityInputs } from "@/lib/now-commitment"

export class NowEligibilityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "NowEligibilityError"
  }
}

export type NowEligibilitySubject = {
  id: string
  workspaceId: string
  solutionId: string | null
  squadId: string | null
}

export interface NowEligibilityResolver {
  resolve(item: NowEligibilitySubject, database?: ReturnType<typeof getPrisma>): Promise<NowCommitmentEligibilityInputs>
}

type WorkspacePolicy = {
  portfolioPolicyId: string
  capacity: {
    planId: string
    planFingerprint: string
    unit: string
    availableUnits: number
    requestedUnits: number
    unitsPerNowItem: number
    nowLimit: number
  }
  investmentDecisions: Record<string, Omit<NowCommitmentEligibilityInputs["investmentDecision"], "subjectId">>
  displacementByRoadmapItemId?: Record<string, NowCommitmentEligibilityInputs["displacement"]>
}

type PolicyDocument = { version: 1; workspaces: Record<string, WorkspacePolicy> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && Number.isSafeInteger(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

function assertPolicyDocument(value: unknown): asserts value is PolicyDocument {
  if (!value || typeof value !== "object") throw new Error("invalid document")
  const document = value as Partial<PolicyDocument>
  if (document.version !== 1 || !document.workspaces || typeof document.workspaces !== "object" || Array.isArray(document.workspaces)) throw new Error("invalid document")
  for (const [workspaceId, policy] of Object.entries(document.workspaces)) {
    if (!UUID.test(workspaceId) || !policy || typeof policy !== "object") throw new Error("invalid workspace mapping")
    if (!nonempty(policy.portfolioPolicyId)) throw new Error("invalid policy id")
    const capacity = policy.capacity
    if (!capacity || !UUID.test(capacity.planId) || !SHA256.test(capacity.planFingerprint) || !nonempty(capacity.unit)
      || !positiveInteger(capacity.availableUnits) || !positiveInteger(capacity.requestedUnits)
      || !positiveInteger(capacity.unitsPerNowItem) || !positiveInteger(capacity.nowLimit)) throw new Error("invalid capacity")
    if (!policy.investmentDecisions || typeof policy.investmentDecisions !== "object" || Array.isArray(policy.investmentDecisions)) throw new Error("invalid investment mappings")
    for (const [solutionId, decision] of Object.entries(policy.investmentDecisions)) {
      if (!UUID.test(solutionId) || !decision || !["OBSIDIAN", "COMPASS"].includes(decision.authorityProvider)
        || !nonempty(decision.authorityRecordId) || !SHA256.test(decision.authorityChecksum)
        || decision.decisionOutcome !== "APPROVE_BUILDING" || decision.applicationStatus !== "APPLIED"
        || !nonempty(decision.applicationReceiptId)) throw new Error("invalid investment decision")
    }
    for (const [candidateId, displacement] of Object.entries(policy.displacementByRoadmapItemId ?? {})) {
      if (!UUID.test(candidateId) || !displacement || !UUID.test(displacement.itemId)
        || !["NEXT", "LATER"].includes(displacement.destination)) throw new Error("invalid displacement")
    }
  }
}

function configuredPolicy(): PolicyDocument {
  const raw = process.env.NOW_COMMITMENT_POLICY_JSON
  if (!raw) throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "NOW commitment policy configuration is unavailable.")
  try {
    const parsed: unknown = JSON.parse(raw)
    assertPolicyDocument(parsed)
    return parsed
  } catch {
    throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "NOW commitment policy configuration is invalid.")
  }
}

export async function resolveNowCommitmentEligibility(item: NowEligibilitySubject, database: ReturnType<typeof getPrisma> = getPrisma()): Promise<NowCommitmentEligibilityInputs> {
  const policy = configuredPolicy().workspaces[item.workspaceId]
  if (!policy) throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "No NOW commitment policy is configured for this workspace.")
  if (!item.solutionId) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "A linked Solution with an applied investment decision is required.")
  const investmentDecision = policy.investmentDecisions?.[item.solutionId]
  if (!investmentDecision) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "No applied Building investment decision is configured for this Solution.")
  const capacity = policy.capacity
  const plan = await database.portfolioCapacityPlan.findUnique({
    where: { id: capacity.planId },
    include: { reservations: { where: { state: "ACTIVE", roadmapItemId: { not: item.id } }, select: { roadmapItemId: true, units: true }, orderBy: { roadmapItemId: "asc" } } },
  })
  if (!plan || plan.workspaceId !== item.workspaceId || plan.policyId !== policy.portfolioPolicyId
    || plan.planFingerprint !== capacity.planFingerprint || plan.unit !== capacity.unit
    || plan.availableUnits !== capacity.availableUnits || plan.nowLimit !== capacity.nowLimit || plan.state !== "ACTIVE") {
    throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "The configured capacity policy does not match an active authoritative workspace plan.")
  }
  return {
    portfolioPolicyId: policy.portfolioPolicyId,
    investmentDecision: { ...investmentDecision, subjectId: item.solutionId },
    capacity: {
      planId: capacity.planId,
      planFingerprint: capacity.planFingerprint,
      unit: capacity.unit,
      availableUnits: capacity.availableUnits,
      requestedUnits: capacity.requestedUnits,
      reservedUnits: plan.reservations.reduce((sum, reservation) => sum + reservation.units, 0),
      reservedRoadmapItemIds: plan.reservations.map(({ roadmapItemId }) => roadmapItemId),
      nowLimit: capacity.nowLimit,
      planVersion: plan.version,
    },
    displacement: policy.displacementByRoadmapItemId?.[item.id],
  }
}

export const defaultNowEligibilityResolver: NowEligibilityResolver = { resolve: resolveNowCommitmentEligibility }
