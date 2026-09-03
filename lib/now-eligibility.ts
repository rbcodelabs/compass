import { readFileSync } from "node:fs"
import getPrisma from "@/lib/db"
import type { NowCommitmentEligibilityInputs } from "@/lib/now-commitment"
import { configuredObsidianInvestmentVerifier } from "@/lib/obsidian-decision-evidence"
import { verifyNativeNowPolicyBundle, type NativeNowPolicyBundle } from "@/lib/native-now-policy"
import { investmentAuthorityChecksum, type NativeDecisionEvidence } from "@/lib/native-decision-evidence"
import { buildingInvestmentSourceFingerprint } from "@/lib/building-investment"
import { configuredDecisionRouting } from "@/lib/decision-routing"
export { investmentAuthorityChecksum } from "@/lib/native-decision-evidence"

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
  verify(input: { workspaceId: string; solutionId: string; reference: ObsidianInvestmentReference }): Promise<boolean>
}

export type ObsidianInvestmentReference = Omit<NowCommitmentEligibilityInputs["investmentDecision"], "subjectId"> & {
  authorityProvider: "OBSIDIAN"
  authorityLocator: string
  decisionSourceVersion: string
  appliedAt: string
  verifiedAt: string
  verifierVersion: string
  routingFingerprint: string
  sourceFileSha256: string
  signingKeyId: string
  attestationSignature: string
}

type WorkspacePolicy = {
  portfolioPolicyId: string
  capacity: {
    planId: string
    planFingerprint: string
    planVersion?: number
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
export type NativePolicyEvidence = {
  workspaceId: string; artifactId: string; payloadHash: string; activationDecisionId: string; activationApplicationReceiptId: string; activationDecisionChecksum: string
  selectorMode: "enforce"; selectorSignature: string; signingKeyId: string; routingFingerprint: string
  capacityPlanId: string; capacityPlanFingerprint: string; capacityPlanVersion: number; generatedAt: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const OBSIDIAN_DECISION_ROOT = "Products/Compass/Reviews/Decisions/"
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
      if (decision.authorityProvider === "OBSIDIAN" && (!nonempty(decision.authorityLocator)
        || !decision.authorityLocator.startsWith(OBSIDIAN_DECISION_ROOT) || decision.authorityLocator.includes("..")
        || !nonempty(decision.decisionSourceVersion) || !RFC3339.test(decision.appliedAt ?? "")
        || !RFC3339.test(decision.verifiedAt ?? "") || !nonempty(decision.verifierVersion)
        || !/^sha256:[0-9a-f]{64}$/i.test(decision.routingFingerprint ?? "")
        || !SHA256.test(decision.sourceFileSha256 ?? "") || !nonempty(decision.signingKeyId)
        || !nonempty(decision.attestationSignature))) throw new Error("invalid Obsidian investment decision")
    }
    for (const [candidateId, displacement] of Object.entries(policy.displacementByRoadmapItemId ?? {})) {
      if (!UUID.test(candidateId) || !displacement || !UUID.test(displacement.itemId)
        || displacement.destination !== "NEXT") throw new Error("invalid displacement")
    }
  }
}

function configuredPolicy(): PolicyDocument & { nativePolicyEvidence?: NativePolicyEvidence } {
  try {
    const raw = process.env.NOW_COMMITMENT_POLICY_JSON
      ?? (process.env.NOW_COMMITMENT_POLICY_FILE ? readFileSync(process.env.NOW_COMMITMENT_POLICY_FILE, "utf8") : undefined)
    if (!raw) throw new Error("missing policy")
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && "artifact" in parsed) {
      const publicKeys: unknown = JSON.parse(process.env.NOW_DECISION_PUBLIC_KEYS_JSON ?? "")
      if (!publicKeys || typeof publicKeys !== "object" || Array.isArray(publicKeys)) throw new Error("invalid keys")
      const bundle = parsed as NativeNowPolicyBundle
      const verified = verifyNativeNowPolicyBundle(bundle, publicKeys as Record<string, string>, new Date(), configuredDecisionRouting().fingerprint)
      assertPolicyDocument(verified)
      return { ...verified, nativePolicyEvidence: { workspaceId: bundle.artifact.workspaceId, artifactId: bundle.artifact.artifactId, payloadHash: bundle.artifact.artifactId.slice("now-policy:v1:sha256:".length), activationDecisionId: bundle.artifact.activationDecision.recordId, activationApplicationReceiptId: bundle.artifact.activationDecision.applicationReceiptId, activationDecisionChecksum: bundle.artifact.activationDecision.checksum, selectorMode: "enforce", selectorSignature: bundle.selectorSignature, signingKeyId: bundle.artifact.signingKeyId, routingFingerprint: bundle.artifact.routingFingerprint, capacityPlanId: bundle.artifact.capacityPlan.id, capacityPlanFingerprint: bundle.artifact.capacityPlan.fingerprint, capacityPlanVersion: bundle.artifact.capacityPlan.version, generatedAt: bundle.artifact.generatedAt } }
    }
    assertPolicyDocument(parsed)
    if (Object.values(parsed.workspaces).some((workspace) => Object.values(workspace.investmentDecisions).some((decision) => decision.authorityProvider === "COMPASS_NATIVE"))) {
      throw new Error("unsigned native policy")
    }
    return parsed
  } catch {
    throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "NOW commitment policy configuration is invalid.")
  }
}

export async function resolveNowCommitmentEligibility(
  item: NowEligibilitySubject,
  database: ReturnType<typeof getPrisma> = getPrisma(),
  adapters: { obsidianVerifier?: ObsidianInvestmentVerifier } = { obsidianVerifier: configuredObsidianInvestmentVerifier },
): Promise<NowCommitmentEligibilityInputs> {
  const configured = configuredPolicy()
  const policy = configured.workspaces[item.workspaceId]
  if (!policy) throw new NowEligibilityError("POLICY_CONFIGURATION_REQUIRED", "No NOW commitment policy is configured for this workspace.")
  if (!item.solutionId) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "A linked Solution with an applied investment decision is required.")
  const investmentDecision = policy.investmentDecisions?.[item.solutionId]
  if (!investmentDecision) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "No applied Building investment decision is configured for this Solution.")
  if (investmentDecision.authorityProvider === "OBSIDIAN") {
    if (!adapters.obsidianVerifier || !await adapters.obsidianVerifier.verify({ workspaceId: item.workspaceId, solutionId: item.solutionId, reference: investmentDecision as ObsidianInvestmentReference })) {
      throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "Obsidian investment authority is unavailable or did not verify this reference.")
    }
  } else {
    const decision = await database.decisionRecord.findUnique({
      where: { id: investmentDecision.authorityRecordId },
      include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true },
    }) as NativeDecisionEvidence | null
    const solution = await database.solution.findUnique({ where: { id: item.solutionId }, select: {
      id: true, title: true, description: true, status: true, updatedAt: true,
      opportunity: { select: { id: true, title: true, workspaceId: true } },
    } })
    const application = decision?.applications.find((candidate) => candidate.id === investmentDecision.applicationReceiptId)
    const liveSourceFingerprint = solution ? buildingInvestmentSourceFingerprint(solution) : null
    const authorityChecksum = decision && application ? investmentAuthorityChecksum(decision, application.id) : null
    const authorityFailures = !decision ? ["decision_missing"] : [
      decision.workspaceId !== item.workspaceId && "decision_workspace",
      decision.revision.request.workspaceId !== item.workspaceId && "request_workspace",
      decision.revision.request.gateType !== "BUILDING_INVESTMENT" && "gate_type",
      decision.revision.request.subjectType !== "SOLUTION" && "subject_type",
      decision.revision.request.subjectId !== item.solutionId && "subject_id",
      decision.option.outcomeClass !== "APPROVE" && "outcome",
      decision.requestId !== decision.revision.request.id && "decision_request",
      decision.request?.id !== decision.requestId && "direct_request",
      decision.request?.state !== "DECIDED" && "request_state",
      decision.request?.currentRevisionId !== decision.revisionId && "current_revision",
      !decision.revision.options?.some((option) => option.id === decision.optionId) && "option_revision",
      !solution && "solution_missing",
      solution?.opportunity.workspaceId !== item.workspaceId && "solution_workspace",
      (decision.revision as typeof decision.revision & { sourceFingerprint?: string | null }).sourceFingerprint !== liveSourceFingerprint && "source_fingerprint",
      decision.option.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT" && "continuation",
      Boolean(decision.revision.supersededAt) && "superseded",
      decision.fingerprint !== decision.revision.fingerprint && "decision_fingerprint",
      !application && "application_missing",
      application?.status !== "APPLIED" && "application_status",
      application?.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT" && "application_continuation",
      application?.targetType !== "SOLUTION" && "application_target_type",
      application?.targetId !== item.solutionId && "application_target_id",
      authorityChecksum !== investmentDecision.authorityChecksum && "authority_checksum",
    ].filter(Boolean)
    if (authorityFailures.length) {
      throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "Compass could not verify the configured Building investment authority.")
    }
    if (!decision || !application) throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "Compass could not verify the configured Building investment authority.")
    const revocations = await database.decisionRecord.findMany({ where: { workspaceId: item.workspaceId, revision: { request: { workspaceId: item.workspaceId, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: item.solutionId }, supersededAt: null }, option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" }, applications: { some: { status: "APPLIED", continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: item.solutionId } } }, include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true } }) as Array<NativeDecisionEvidence & { revision: NativeDecisionEvidence["revision"] & { packetJson: string } }>
    for (const revocation of revocations) {
      const packet = JSON.parse(revocation.revision.packetJson) as { authorityDecisionId?: string; authorityReceiptId?: string }
      if (packet.authorityDecisionId !== decision.id) continue
      const revocationReceipt = revocation.applications.find((candidate) => candidate.status === "APPLIED" && candidate.continuationKey === "REVOKE_BUILDING_INVESTMENT" && candidate.targetType === "SOLUTION" && candidate.targetId === item.solutionId)
      if (revocation.workspaceId !== item.workspaceId || revocation.requestId !== revocation.revision.request.id || revocation.request?.id !== revocation.requestId
        || revocation.request?.state !== "DECIDED" || revocation.request?.currentRevisionId !== revocation.revisionId || revocation.revision.supersededAt
        || !revocation.revision.options?.some((option) => option.id === revocation.optionId) || revocation.option.outcomeClass !== "APPROVE"
        || revocation.option.continuationKey !== "REVOKE_BUILDING_INVESTMENT" || packet.authorityReceiptId !== application.id || !revocationReceipt) {
        throw new NowEligibilityError("NO_APPLIED_INVESTMENT_DECISION", "Compass found malformed revocation evidence for this Building authority.")
      }
      throw new NowEligibilityError("INVESTMENT_AUTHORITY_REVOKED", "The configured Building investment authority has been revoked.")
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
    || plan.nowLimit !== capacity.nowLimit || (capacity.planVersion !== undefined && plan.version !== capacity.planVersion)
    || plan.state !== "ACTIVE" || plan.activeWorkspaceId !== item.workspaceId) {
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
    policyEvidence: configured.nativePolicyEvidence,
  }
}

export const defaultNowEligibilityResolver: NowEligibilityResolver = { resolve: resolveNowCommitmentEligibility }
