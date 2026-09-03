import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
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

export interface ObsidianInvestmentVerifier {
  verify(input: { workspaceId: string; solutionId: string; reference: Omit<NowCommitmentEligibilityInputs["investmentDecision"], "subjectId"> }): Promise<boolean>
}

type NativeDecisionEvidence = {
  id: string
  workspaceId: string
  revisionId: string
  optionId: string
  fingerprint: string
  decidedAt: Date
  revision: { fingerprint: string; supersededAt: Date | null; request: { gateType: string; subjectType: string; subjectId: string; workspaceId: string } }
  option: { outcomeClass: string; continuationKey: string }
  applications: Array<{ id: string; status: string; continuationKey: string; targetType: string; targetId: string }>
}

export function investmentAuthorityChecksum(evidence: NativeDecisionEvidence, applicationId: string): string {
  return createHash("sha256").update(JSON.stringify({
    authority: "COMPASS_NATIVE",
    decisionId: evidence.id,
    workspaceId: evidence.workspaceId,
    solutionId: evidence.revision.request.subjectId,
    revisionId: evidence.revisionId,
    optionId: evidence.optionId,
    fingerprint: evidence.fingerprint,
    decidedAt: evidence.decidedAt.toISOString(),
    applicationId,
    continuationKey: "AUTHORIZE_BUILDING_INVESTMENT",
  })).digest("hex")
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
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

function assertPolicyDocument(value: unknown): asserts value is PolicyDocument {
  if (!value || typeof value !== "object") throw new Error("invalid document")
  const document = value as Partial<PolicyDocument>
  if (document.version !== 1 || !document.workspaces || typeof document.workspaces !== "object" || Array.isArray(document.workspaces)) throw new Error("invalid document")
  for (const [workspaceId, policy] of Object.entries(document.workspaces)) {
    if (!UUID.test(workspaceId) || !policy || typeof policy !== "object") throw new Error("invalid workspace mapping")
    if (!nonempty(policy.portfolioPolicyId)) throw new Error("invalid policy id")
    const capacity = policy.capacity
    if (!capacity || !UUID.test(capacity.planId) || !SHA256.test(capacity.planFingerprint)
      || capacity.unit !== "FOCUS_SLOT" || capacity.availableUnits !== 3 || capacity.requestedUnits !== 1
      || capacity.unitsPerNowItem !== 1 || capacity.nowLimit !== 3) throw new Error("invalid capacity")
    if (!policy.investmentDecisions || typeof policy.investmentDecisions !== "object" || Array.isArray(policy.investmentDecisions)) throw new Error("invalid investment mappings")
    for (const [solutionId, decision] of Object.entries(policy.investmentDecisions)) {
      if (!UUID.test(solutionId) || !decision || !["OBSIDIAN", "COMPASS_NATIVE"].includes(decision.authorityProvider)
        || !nonempty(decision.authorityRecordId) || !SHA256.test(decision.authorityChecksum)
        || decision.decisionOutcome !== "APPROVE_BUILDING" || decision.applicationStatus !== "APPLIED"
        || !nonempty(decision.applicationReceiptId)
        || (decision.authorityProvider === "COMPASS_NATIVE" && (!UUID.test(decision.authorityRecordId) || !UUID.test(decision.applicationReceiptId)))) throw new Error("invalid investment decision")
    }
    for (const [candidateId, displacement] of Object.entries(policy.displacementByRoadmapItemId ?? {})) {
      if (!UUID.test(candidateId) || !displacement || !UUID.test(displacement.itemId)
        || displacement.destination !== "NEXT") throw new Error("invalid displacement")
    }
  }
}

function configuredPolicy(): PolicyDocument {
  try {
    const raw = process.env.NOW_COMMITMENT_POLICY_JSON
      ?? (process.env.NOW_COMMITMENT_POLICY_FILE ? readFileSync(process.env.NOW_COMMITMENT_POLICY_FILE, "utf8") : undefined)
    if (!raw) throw new Error("missing policy")
    const parsed: unknown = JSON.parse(raw)
    assertPolicyDocument(parsed)
    return parsed
  } catch {
    throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "NOW commitment policy configuration is invalid.")
  }
}

export async function resolveNowCommitmentEligibility(
  item: NowEligibilitySubject,
  database: ReturnType<typeof getPrisma> = getPrisma(),
  adapters: { obsidianVerifier?: ObsidianInvestmentVerifier } = {},
): Promise<NowCommitmentEligibilityInputs> {
  const policy = configuredPolicy().workspaces[item.workspaceId]
  if (!policy) throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "No NOW commitment policy is configured for this workspace.")
  if (!item.solutionId) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "A linked Solution with an applied investment decision is required.")
  const investmentDecision = policy.investmentDecisions?.[item.solutionId]
  if (!investmentDecision) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "No applied Building investment decision is configured for this Solution.")
  if (investmentDecision.authorityProvider === "OBSIDIAN") {
    if (!adapters.obsidianVerifier || !await adapters.obsidianVerifier.verify({ workspaceId: item.workspaceId, solutionId: item.solutionId, reference: investmentDecision })) {
      throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "Obsidian investment authority is unavailable or did not verify this reference.")
    }
  } else {
    const decision = await database.decisionRecord.findUnique({
      where: { id: investmentDecision.authorityRecordId },
      include: { revision: { include: { request: true } }, option: true, applications: true },
    }) as NativeDecisionEvidence | null
    const application = decision?.applications.find((candidate) => candidate.id === investmentDecision.applicationReceiptId)
    if (!decision || decision.workspaceId !== item.workspaceId || decision.revision.request.workspaceId !== item.workspaceId
      || decision.revision.request.gateType !== "BUILDING_INVESTMENT" || decision.revision.request.subjectType !== "SOLUTION"
      || decision.revision.request.subjectId !== item.solutionId || decision.option.outcomeClass !== "APPROVE"
      || decision.option.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT" || decision.revision.supersededAt
      || decision.fingerprint !== decision.revision.fingerprint || !application || application.status !== "APPLIED"
      || application.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT" || application.targetType !== "SOLUTION"
      || application.targetId !== item.solutionId || investmentAuthorityChecksum(decision, application.id) !== investmentDecision.authorityChecksum) {
      throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "Compass could not verify the configured Building investment authority.")
    }
  }
  const capacity = policy.capacity
  const plan = await database.portfolioCapacityPlan.findUnique({
    where: { id: capacity.planId },
    include: { reservations: { where: { state: "ACTIVE", roadmapItemId: { not: item.id } }, select: { roadmapItemId: true, units: true }, orderBy: { roadmapItemId: "asc" } } },
  })
  if (!plan || plan.workspaceId !== item.workspaceId || plan.policyId !== policy.portfolioPolicyId
    || plan.planFingerprint !== capacity.planFingerprint || plan.unit !== capacity.unit
    || plan.availableUnits !== capacity.availableUnits || plan.unitsPerNowItem !== capacity.unitsPerNowItem
    || plan.nowLimit !== capacity.nowLimit || plan.state !== "ACTIVE" || plan.activeWorkspaceId !== item.workspaceId) {
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
      unitsPerNowItem: capacity.unitsPerNowItem,
      reservedUnits: plan.reservations.reduce((sum, reservation) => sum + reservation.units, 0),
      reservedRoadmapItemIds: plan.reservations.map(({ roadmapItemId }) => roadmapItemId),
      nowLimit: capacity.nowLimit,
      planVersion: plan.version,
    },
    displacement: policy.displacementByRoadmapItemId?.[item.id],
  }
}

export const defaultNowEligibilityResolver: NowEligibilityResolver = { resolve: resolveNowCommitmentEligibility }
