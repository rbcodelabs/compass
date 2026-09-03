import { createHash, sign, type KeyLike } from "node:crypto"
import getPrisma from "@/lib/db"
import { generateNativeNowPolicy, nativePolicyCandidateFingerprint, NativeNowPolicyError, type GeneratedNativePolicy } from "@/lib/native-now-policy"
import { configuredDecisionRouting } from "@/lib/decision-routing"

type SigningInput = { signingKeyId: string; privateKey: KeyLike; routingFingerprint: string; generatedAt: string; validUntil: string; activationDecision: { recordId: string; applicationReceiptId: string; checksum: string }; mode: "shadow" | "enforce"; supersedesArtifactId?: string | null }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function signBundle(generated: GeneratedNativePolicy, input: SigningInput) {
  const workspaceId = generated.inspection.workspaceId, workspacePolicy = generated.document.workspaces[workspaceId]
  const generatedAt = Date.parse(input.generatedAt), validUntil = Date.parse(input.validUntil)
  if (!/^sha256:[0-9a-f]{64}$/i.test(input.routingFingerprint) || !/^[0-9a-f]{64}$/i.test(input.activationDecision.checksum) || !input.signingKeyId || !workspacePolicy
    || !Number.isFinite(generatedAt) || !Number.isFinite(validUntil) || generatedAt >= validUntil || validUntil - generatedAt > 30 * 24 * 60 * 60_000) {
    throw new NativeNowPolicyError("INVALID_SIGNING_INPUT", "Policy signing inputs or validity window are invalid.")
  }
  const payload = { schemaVersion: "compass-now-policy/v1" as const, workspaceId, routingFingerprint: input.routingFingerprint, portfolioPolicy: { policyId: workspacePolicy.portfolioPolicyId, canonical: workspacePolicy }, capacityPlan: { id: workspacePolicy.capacity.planId, fingerprint: workspacePolicy.capacity.planFingerprint, version: generated.inspection.capacityPlanVersion, expectedState: "ACTIVE" as const }, investmentEvidence: workspacePolicy.investmentDecisions, generatedAt: input.generatedAt, validUntil: input.validUntil, supersedesArtifactId: input.supersedesArtifactId ?? null, activationDecision: input.activationDecision, signingKeyId: input.signingKeyId }
  const artifactId = `now-policy:v1:sha256:${digest(JSON.stringify(payload))}`, artifact = { ...payload, artifactId }
  const selector = { schemaVersion: "compass-now-policy-selector/v1" as const, workspaceId, artifactId, mode: input.mode, activationDecisionChecksum: input.activationDecision.checksum, supersedesArtifactId: input.supersedesArtifactId ?? null, signingKeyId: input.signingKeyId }
  return { artifact, artifactSignature: sign(null, Buffer.from(JSON.stringify(artifact)), input.privateKey).toString("base64"), selector, selectorSignature: sign(null, Buffer.from(JSON.stringify(selector)), input.privateKey).toString("base64") }
}
export type NativeNowPolicyBundle = ReturnType<typeof signBundle>

export async function generateSignedNativeNowPolicyBundle(workspaceId: string, activationDecisionId: string, input: Omit<SigningInput, "activationDecision">, database: ReturnType<typeof getPrisma> = getPrisma()) {
  const routingFingerprint = configuredDecisionRouting().fingerprint
  if (input.routingFingerprint && input.routingFingerprint !== routingFingerprint) throw new NativeNowPolicyError("ROUTING_FINGERPRINT_MISMATCH", "Signing assertion does not match canonical routing.")
  const generated = await generateNativeNowPolicy(workspaceId, database)
  const decision = await database.decisionRecord.findUnique({ where: { id: activationDecisionId }, include: { request: true, revision: { include: { request: true, options: { select: { id: true } } } }, option: true, applications: true } })
  const receipt = decision?.applications.find((candidate) => candidate.status === "APPLIED" && candidate.continuationKey === "AUTHORIZE_NOW_POLICY")
  const expectedSource = nativePolicyCandidateFingerprint(generated, routingFingerprint, input.mode)
  if (!decision || decision.workspaceId !== workspaceId || decision.revision.request.workspaceId !== workspaceId || decision.revision.request.gateType !== "NOW_POLICY_ACTIVATION" || decision.revision.request.subjectType !== "WORKSPACE" || decision.revision.request.subjectId !== workspaceId || decision.revision.request.state !== "DECIDED" || decision.requestId !== decision.revision.request.id || decision.request.id !== decision.requestId || decision.revision.request.currentRevisionId !== decision.revisionId || decision.revision.supersededAt || decision.fingerprint !== decision.revision.fingerprint || decision.revision.sourceFingerprint !== expectedSource || !decision.revision.options.some((option) => option.id === decision.optionId) || decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== "AUTHORIZE_NOW_POLICY" || !receipt || receipt.targetType !== "WORKSPACE" || receipt.targetId !== workspaceId) throw new NativeNowPolicyError("ACTIVATION_DECISION_REQUIRED", "An applied native decision for this exact policy candidate is required before signing.")
  const activationChecksum = digest(JSON.stringify({ schemaVersion: "compass-now-policy-activation/v1", workspaceId, decisionId: decision.id, revisionId: decision.revisionId, fingerprint: decision.fingerprint, receiptId: receipt.id, sourceFingerprint: expectedSource }))
  return signBundle(generated, { ...input, routingFingerprint, activationDecision: { recordId: decision.id, applicationReceiptId: receipt.id, checksum: activationChecksum } })
}
