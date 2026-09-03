import getPrisma from "@/lib/db"
import { investmentAuthorityChecksum } from "@/lib/native-decision-evidence"
import { createHash, verify, type KeyLike } from "node:crypto"
import { buildingInvestmentSourceFingerprint } from "@/lib/building-investment"
import type { NativeNowPolicyBundle } from "@/lib/native-now-policy-signing"
export type { NativeNowPolicyBundle } from "@/lib/native-now-policy-signing"

export class NativeNowPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "NativeNowPolicyError"
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i

type Database = ReturnType<typeof getPrisma>
type NativeDecision = Awaited<ReturnType<Database["decisionRecord"]["findMany"]>>[number] & {
  requestId: string; revisionId: string; optionId: string; fingerprint: string; decidedAt: Date
  request: { id: string; state: string; currentRevisionId: string | null }
  revision: { fingerprint: string; sourceFingerprint: string | null; supersededAt: Date | null; options: Array<{ id: string }>; request: { id: string; workspaceId: string; gateType: string; subjectType: string; subjectId: string; state: string; currentRevisionId: string | null } }
  option: { outcomeClass: string; continuationKey: string }
  applications: Array<{ id: string; status: string; continuationKey: string; targetType: string; targetId: string }>
}

type InvestmentSolution = { id: string; title: string; description: string | null; status: string; updatedAt: Date; opportunity: { id: string; title: string; workspaceId: string } }
function verifiedReceipt(decision: NativeDecision, workspaceId: string, solution: InvestmentSolution | undefined) {
  const request = decision.revision.request
  const receipts = decision.applications.filter((application) => application.status === "APPLIED" && application.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT")
  if (decision.workspaceId !== workspaceId || request.workspaceId !== workspaceId || request.gateType !== "BUILDING_INVESTMENT"
    || request.subjectType !== "SOLUTION" || request.state !== "DECIDED" || request.currentRevisionId !== decision.revisionId
    || decision.requestId !== request.id || decision.request.id !== decision.requestId
    || decision.fingerprint !== decision.revision.fingerprint || decision.revision.supersededAt
    || !solution || solution.opportunity.workspaceId !== workspaceId || decision.revision.sourceFingerprint !== buildingInvestmentSourceFingerprint(solution)
    || decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT"
    || !decision.revision.options.some((option) => option.id === decision.optionId)
    || receipts.length !== 1 || receipts[0].targetType !== "SOLUTION" || receipts[0].targetId !== request.subjectId) return null
  return receipts[0]
}

export async function generateNativeNowPolicy(workspaceId: string, database: Database = getPrisma()) {
  const plan = await database.portfolioCapacityPlan.findFirst({
    where: { workspaceId, state: "ACTIVE", activeWorkspaceId: workspaceId },
  })
  if (!plan || plan.workspaceId !== workspaceId || plan.activeWorkspaceId !== workspaceId || plan.state !== "ACTIVE"
    || !plan.planFingerprint || plan.unit !== "FOCUS_SLOT" || plan.availableUnits !== 3 || plan.unitsPerNowItem !== 1 || plan.nowLimit !== 3) {
    throw new NativeNowPolicyError("ACTIVE_CAPACITY_PLAN_REQUIRED", "A verified active workspace capacity plan is required.")
  }
  const decisions = await database.decisionRecord.findMany({
    where: {
      workspaceId,
      revision: { request: { workspaceId, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION" }, supersededAt: null },
      option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
      applications: { some: { status: "APPLIED", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION" } },
    },
    include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  }) as unknown as NativeDecision[]
  const revocations = await database.decisionRecord.findMany({
    where: { workspaceId, revision: { request: { workspaceId, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION" }, supersededAt: null }, option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" }, applications: { some: { status: "APPLIED", continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION" } } },
    include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true },
  }) as unknown as NativeDecision[]
  const revocationPackets = revocations.map((revocation) => JSON.parse((revocation.revision as typeof revocation.revision & { packetJson?: string }).packetJson ?? "{}") as { authorityDecisionId?: string; authorityReceiptId?: string; authorityChecksum?: string; solution?: { id?: string } })
  const historicalAuthorityIds = [...new Set(revocationPackets.map((packet) => packet.authorityDecisionId).filter((id): id is string => Boolean(id)))]
  const historicalAuthorities = historicalAuthorityIds.length ? (await database.decisionRecord.findMany({
    where: { workspaceId, id: { in: historicalAuthorityIds } },
    include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true },
  }) ?? []) as unknown as NativeDecision[] : []
  const authorityById = new Map([...decisions, ...historicalAuthorities].map((decision) => [decision.id, decision]))
  const revokedAuthorityIds = new Set<string>()
  for (const [index, revocation] of revocations.entries()) {
    if (revocation.revision.request.gateType !== "BUILDING_INVESTMENT_REVOCATION") continue
    const packet = revocationPackets[index]
    const receipt = revocation.applications.find((candidate) => candidate.status === "APPLIED" && candidate.continuationKey === "REVOKE_BUILDING_INVESTMENT" && candidate.targetType === "SOLUTION" && candidate.targetId === revocation.revision.request.subjectId)
    const authority = packet.authorityDecisionId ? authorityById.get(packet.authorityDecisionId) : undefined
    const authorityReceipt = authority?.applications.find((candidate) => candidate.id === packet.authorityReceiptId && candidate.status === "APPLIED" && candidate.continuationKey === "AUTHORIZE_BUILDING_INVESTMENT" && candidate.targetType === "SOLUTION" && candidate.targetId === revocation.revision.request.subjectId)
    if (revocation.workspaceId !== workspaceId || revocation.requestId !== revocation.revision.request.id || revocation.request.id !== revocation.requestId
      || revocation.request.state !== "DECIDED" || revocation.request.currentRevisionId !== revocation.revisionId || revocation.fingerprint !== revocation.revision.fingerprint
      || !revocation.revision.options.some((option) => option.id === revocation.optionId) || revocation.option.outcomeClass !== "APPROVE"
      || revocation.option.continuationKey !== "REVOKE_BUILDING_INVESTMENT" || !receipt || !packet.authorityDecisionId || !packet.authorityReceiptId || !packet.authorityChecksum
      || packet.solution?.id !== revocation.revision.request.subjectId
      || !authority || authority.workspaceId !== workspaceId || authority.requestId !== authority.revision.request.id || authority.request.id !== authority.requestId
      || authority.revision.request.workspaceId !== workspaceId || authority.revision.request.gateType !== "BUILDING_INVESTMENT" || authority.revision.request.subjectType !== "SOLUTION"
      || authority.revision.request.subjectId !== revocation.revision.request.subjectId || authority.fingerprint !== authority.revision.fingerprint
      || !authority.revision.options.some((option) => option.id === authority.optionId) || authority.option.outcomeClass !== "APPROVE" || authority.option.continuationKey !== "AUTHORIZE_BUILDING_INVESTMENT"
      || !authorityReceipt || packet.authorityChecksum !== investmentAuthorityChecksum(authority, authorityReceipt.id)) {
      throw new NativeNowPolicyError("DECISION_INTEGRITY_FAILURE", "A Building investment revocation failed integrity verification.")
    }
    revokedAuthorityIds.add(packet.authorityDecisionId)
  }
  const solutions = decisions.length ? await database.solution.findMany({
    where: { id: { in: decisions.map((decision) => decision.revision.request.subjectId) } },
    select: { id: true, title: true, description: true, status: true, updatedAt: true, opportunity: { select: { id: true, title: true, workspaceId: true } } },
  }) : []
  const solutionById = new Map(solutions.map((solution) => [solution.id, solution]))
  const entries: Record<string, { authorityProvider: "COMPASS_NATIVE"; authorityRecordId: string; authorityChecksum: string; decisionOutcome: "APPROVE_BUILDING"; applicationStatus: "APPLIED"; applicationReceiptId: string }> = {}
  const rejectedDecisionIds: string[] = []
  for (const decision of decisions) {
    if (revokedAuthorityIds.has(decision.id)) continue
    const receipt = verifiedReceipt(decision, workspaceId, solutionById.get(decision.revision.request.subjectId))
    if (!receipt || entries[decision.revision.request.subjectId]) {
      rejectedDecisionIds.push(decision.id)
      continue
    }
    entries[decision.revision.request.subjectId] = {
      authorityProvider: "COMPASS_NATIVE",
      authorityRecordId: decision.id,
      authorityChecksum: investmentAuthorityChecksum(decision, receipt.id),
      decisionOutcome: "APPROVE_BUILDING",
      applicationStatus: "APPLIED",
      applicationReceiptId: receipt.id,
    }
  }
  if (rejectedDecisionIds.length) throw new NativeNowPolicyError("DECISION_INTEGRITY_FAILURE", "One or more selected investment decisions failed integrity verification.")
  const orderedEntries = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)))
  const document = { version: 1 as const, workspaces: { [workspaceId]: {
    portfolioPolicyId: plan.policyId,
    capacity: { planId: plan.id, planFingerprint: plan.planFingerprint, planVersion: plan.version, unit: plan.unit, availableUnits: plan.availableUnits, requestedUnits: 1, unitsPerNowItem: plan.unitsPerNowItem, nowLimit: plan.nowLimit },
    investmentDecisions: orderedEntries,
    displacementByRoadmapItemId: {},
  } } }
  return { document, inspection: { provider: "compass_decision_ledger", workspaceId, capacityPlanId: plan.id, capacityPlanVersion: plan.version, capacityPlanFingerprint: plan.planFingerprint, verifiedDecisionCount: Object.keys(orderedEntries).length, rejectedDecisionIds, ready: true } }
}

export type GeneratedNativePolicy = Awaited<ReturnType<typeof generateNativeNowPolicy>>
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

export function nativePolicyCandidateFingerprint(generated: GeneratedNativePolicy, routingFingerprint: string, mode: "shadow" | "enforce") {
  return digest(JSON.stringify({ schemaVersion: "compass-now-policy-candidate/v1", document: generated.document, inspection: generated.inspection, routingFingerprint, mode }))
}

export function verifyNativeNowPolicyBundle(bundle: NativeNowPolicyBundle, publicKeys: Record<string, KeyLike>, now = new Date(), expectedRoutingFingerprint?: string) {
  const exactKeys = (value: object, keys: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  if (!bundle || !exactKeys(bundle, ["artifact", "artifactSignature", "selector", "selectorSignature"])
    || !exactKeys(bundle.artifact, ["schemaVersion", "workspaceId", "routingFingerprint", "portfolioPolicy", "capacityPlan", "investmentEvidence", "generatedAt", "validUntil", "supersedesArtifactId", "activationDecision", "signingKeyId", "artifactId"])
    || !exactKeys(bundle.selector, ["schemaVersion", "workspaceId", "artifactId", "mode", "activationDecisionChecksum", "supersedesArtifactId", "signingKeyId"])
    || !exactKeys(bundle.artifact.activationDecision, ["recordId", "applicationReceiptId", "checksum"])
    || bundle.artifact.schemaVersion !== "compass-now-policy/v1" || bundle.selector.schemaVersion !== "compass-now-policy-selector/v1") {
    throw new NativeNowPolicyError("POLICY_SCHEMA_INVALID", "Policy bundle uses an unsupported or open schema.")
  }
  const key = publicKeys[bundle.artifact.signingKeyId]
  if (!key || bundle.selector.signingKeyId !== bundle.artifact.signingKeyId
    || !verify(null, Buffer.from(JSON.stringify(bundle.artifact)), key, Buffer.from(bundle.artifactSignature, "base64"))
    || !verify(null, Buffer.from(JSON.stringify(bundle.selector)), key, Buffer.from(bundle.selectorSignature, "base64"))) {
    throw new NativeNowPolicyError("POLICY_SIGNATURE_INVALID", "Policy artifact or selector signature is invalid.")
  }
  const { artifactId, ...payload } = bundle.artifact
  const expectedId = `now-policy:v1:sha256:${digest(JSON.stringify(payload))}`
  const canonical = bundle.artifact.portfolioPolicy.canonical
  if (artifactId !== expectedId || bundle.selector.artifactId !== artifactId
    || bundle.selector.workspaceId !== bundle.artifact.workspaceId
    || bundle.selector.activationDecisionChecksum !== bundle.artifact.activationDecision.checksum
    || bundle.selector.supersedesArtifactId !== bundle.artifact.supersedesArtifactId
    || !["shadow", "enforce"].includes(bundle.selector.mode)
    || bundle.artifact.portfolioPolicy.policyId !== canonical.portfolioPolicyId
    || bundle.artifact.capacityPlan.expectedState !== "ACTIVE"
    || bundle.artifact.capacityPlan.id !== canonical.capacity.planId
    || bundle.artifact.capacityPlan.fingerprint !== canonical.capacity.planFingerprint
    || bundle.artifact.capacityPlan.version !== canonical.capacity.planVersion
    || JSON.stringify(bundle.artifact.investmentEvidence) !== JSON.stringify(canonical.investmentDecisions)
    || !UUID.test(bundle.artifact.workspaceId) || !UUID.test(bundle.artifact.activationDecision.recordId) || !UUID.test(bundle.artifact.activationDecision.applicationReceiptId)
    || !SHA256.test(bundle.artifact.activationDecision.checksum)) {
    throw new NativeNowPolicyError("POLICY_BINDING_INVALID", "Policy selector does not bind the exact enforceable artifact.")
  }
  if (!expectedRoutingFingerprint || bundle.artifact.routingFingerprint !== expectedRoutingFingerprint) {
    throw new NativeNowPolicyError("ROUTING_FINGERPRINT_MISMATCH", "Policy artifact does not match the configured provider routing.")
  }
  if (!Number.isFinite(Date.parse(bundle.artifact.generatedAt)) || !Number.isFinite(Date.parse(bundle.artifact.validUntil))
    || new Date(bundle.artifact.generatedAt) >= new Date(bundle.artifact.validUntil)
    || new Date(bundle.artifact.generatedAt).getTime() > now.getTime() + 5 * 60_000) {
    throw new NativeNowPolicyError("POLICY_TIME_INVALID", "Policy artifact validity times are invalid.")
  }
  if (!Number.isFinite(Date.parse(bundle.artifact.validUntil)) || now >= new Date(bundle.artifact.validUntil)) {
    throw new NativeNowPolicyError("POLICY_EXPIRED", "Policy artifact has expired.")
  }
  return { version: 1 as const, workspaces: { [bundle.artifact.workspaceId]: bundle.artifact.portfolioPolicy.canonical } }
}
