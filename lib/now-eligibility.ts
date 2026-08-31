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
  resolve(item: NowEligibilitySubject): Promise<NowCommitmentEligibilityInputs>
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

function configuredPolicy(): PolicyDocument {
  const raw = process.env.NOW_COMMITMENT_POLICY_JSON
  if (!raw) throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "NOW commitment policy configuration is unavailable.")
  try {
    const parsed = JSON.parse(raw) as PolicyDocument
    if (parsed.version !== 1 || !parsed.workspaces || typeof parsed.workspaces !== "object") throw new Error("invalid shape")
    return parsed
  } catch {
    throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "NOW commitment policy configuration is invalid.")
  }
}

export async function resolveNowCommitmentEligibility(item: NowEligibilitySubject): Promise<NowCommitmentEligibilityInputs> {
  const policy = configuredPolicy().workspaces[item.workspaceId]
  if (!policy) throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "No NOW commitment policy is configured for this workspace.")
  if (!item.solutionId) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "A linked Solution with an applied investment decision is required.")
  const investmentDecision = policy.investmentDecisions?.[item.solutionId]
  if (!investmentDecision) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "No applied Building investment decision is configured for this Solution.")
  const capacity = policy.capacity
  if (!capacity || !Number.isFinite(capacity.unitsPerNowItem) || capacity.unitsPerNowItem <= 0) {
    throw new NowEligibilityError("NO_CAPACITY_PLAN", "The configured capacity plan is incomplete.")
  }
  const reserved = await getPrisma().roadmapItem.findMany({
    where: { workspaceId: item.workspaceId, horizon: "NOW", ...(item.squadId ? { squadId: item.squadId } : {}), id: { not: item.id } },
    select: { id: true },
    orderBy: { id: "asc" },
  })
  return {
    portfolioPolicyId: policy.portfolioPolicyId,
    investmentDecision: { ...investmentDecision, subjectId: item.solutionId },
    capacity: {
      planId: capacity.planId,
      planFingerprint: capacity.planFingerprint,
      unit: capacity.unit,
      availableUnits: capacity.availableUnits,
      requestedUnits: capacity.requestedUnits,
      reservedUnits: reserved.length * capacity.unitsPerNowItem,
      reservedRoadmapItemIds: reserved.map(({ id }) => id).sort(),
      nowLimit: capacity.nowLimit,
    },
    displacement: policy.displacementByRoadmapItemId?.[item.id],
  }
}

export const defaultNowEligibilityResolver: NowEligibilityResolver = { resolve: resolveNowCommitmentEligibility }
