import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { generateNativeNowPolicy, nativePolicyCandidateFingerprint, verifyNativeNowPolicyBundle } from "@/lib/native-now-policy"
import { generateSignedNativeNowPolicyBundle } from "@/lib/native-now-policy-signing"
import { investmentAuthorityChecksum } from "@/lib/now-eligibility"
import { buildingInvestmentSourceFingerprint } from "@/lib/building-investment"
import { nativeRoutingFingerprint, nativeRoutingManifestJson } from "@/__tests__/fixtures/native-routing"

process.env.NOW_DECISION_ROUTING_MANIFEST_JSON = nativeRoutingManifestJson

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001", plan: "00000000-0000-4000-8000-000000000002",
  solution: "00000000-0000-4000-8000-000000000003", decision: "00000000-0000-4000-8000-000000000004",
  revision: "00000000-0000-4000-8000-000000000005", option: "00000000-0000-4000-8000-000000000006",
  receipt: "00000000-0000-4000-8000-000000000007",
}
const solution = { id: ids.solution, title: "Native decisions", description: null, status: "VALIDATED", updatedAt: new Date("2026-09-02T11:00:00Z"), opportunity: { id: "00000000-0000-4000-8000-000000000009", title: "Trusted delivery", workspaceId: ids.workspace } }
const decision = {
  id: ids.decision, requestId: "request-1", workspaceId: ids.workspace, revisionId: ids.revision, optionId: ids.option, fingerprint: "c".repeat(64), decidedAt: new Date("2026-09-02T12:00:00Z"),
  request: { id: "request-1", state: "DECIDED", currentRevisionId: ids.revision },
  revision: { fingerprint: "c".repeat(64), sourceFingerprint: buildingInvestmentSourceFingerprint(solution), supersededAt: null, options: [{ id: ids.option }], request: { id: "request-1", workspaceId: ids.workspace, gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: ids.solution, state: "DECIDED", currentRevisionId: ids.revision } },
  option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
  applications: [{ id: ids.receipt, status: "APPLIED", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: ids.solution }],
}

function database(overrides: Record<string, unknown> = {}) {
  return {
    portfolioCapacityPlan: { findFirst: vi.fn().mockResolvedValue({ id: ids.plan, workspaceId: ids.workspace, policyId: "compass-policy-v1", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, state: "ACTIVE", activeWorkspaceId: ids.workspace }) },
    decisionRecord: { findMany: vi.fn().mockResolvedValue([decision]), findUnique: vi.fn() },
    solution: { findMany: vi.fn().mockResolvedValue([solution]) },
    ...overrides,
  } as never
}

describe("native NOW policy generation", () => {
  it("deterministically emits only verified APPLIED native investment authority", async () => {
    const one = await generateNativeNowPolicy(ids.workspace, database())
    const two = await generateNativeNowPolicy(ids.workspace, database())

    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(one.document.workspaces[ids.workspace]).toEqual(expect.objectContaining({
      portfolioPolicyId: "compass-policy-v1",
      investmentDecisions: { [ids.solution]: expect.objectContaining({
        authorityProvider: "COMPASS_NATIVE", authorityRecordId: ids.decision, applicationReceiptId: ids.receipt,
        authorityChecksum: investmentAuthorityChecksum(decision, ids.receipt),
      }) },
    }))
    expect(one.inspection).toEqual(expect.objectContaining({ ready: true, verifiedDecisionCount: 1, rejectedDecisionIds: [] }))
  })

  it("fails closed without exactly one active workspace-bound capacity plan", async () => {
    const db = database({ portfolioCapacityPlan: { findFirst: vi.fn().mockResolvedValue(null) } })
    await expect(generateNativeNowPolicy(ids.workspace, db)).rejects.toEqual(expect.objectContaining({ code: "ACTIVE_CAPACITY_PLAN_REQUIRED" }))
  })

  it("fails closed when any selected approval has mismatched integrity evidence", async () => {
    const forged = { ...decision, applications: [{ ...decision.applications[0], targetId: "00000000-0000-4000-8000-000000000099" }] }
    const db = database({ decisionRecord: { findMany: vi.fn().mockResolvedValue([forged]) } })
    await expect(generateNativeNowPolicy(ids.workspace, db)).rejects.toEqual(expect.objectContaining({ code: "DECISION_INTEGRITY_FAILURE" }))
  })

  it("rejects a revocation that names authority belonging to a different Solution", async () => {
    const otherSolutionId = "00000000-0000-4000-8000-000000000099"
    const revocation = {
      id: "00000000-0000-4000-8000-000000000091",
      requestId: "revocation-request",
      workspaceId: ids.workspace,
      revisionId: "00000000-0000-4000-8000-000000000092",
      optionId: "00000000-0000-4000-8000-000000000093",
      fingerprint: "e".repeat(64),
      request: { id: "revocation-request", state: "DECIDED", currentRevisionId: "00000000-0000-4000-8000-000000000092" },
      revision: {
        fingerprint: "e".repeat(64),
        sourceFingerprint: "f".repeat(64),
        supersededAt: null,
        packetJson: JSON.stringify({ authorityDecisionId: ids.decision, authorityReceiptId: ids.receipt }),
        options: [{ id: "00000000-0000-4000-8000-000000000093" }],
        request: { id: "revocation-request", workspaceId: ids.workspace, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: otherSolutionId },
      },
      option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" },
      applications: [{ id: "revocation-receipt", status: "APPLIED", continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: otherSolutionId }],
    }
    const db = database({
      decisionRecord: {
        findMany: vi.fn()
          .mockResolvedValueOnce([decision])
          .mockResolvedValueOnce([revocation]),
        findUnique: vi.fn(),
      },
    })

    await expect(generateNativeNowPolicy(ids.workspace, db))
      .rejects.toEqual(expect.objectContaining({ code: "DECISION_INTEGRITY_FAILURE" }))
  })

  it("preserves revoked history while selecting a later reauthorization", async () => {
    const old = { ...decision, id: "00000000-0000-4000-8000-000000000081", revisionId: "00000000-0000-4000-8000-000000000082", optionId: "00000000-0000-4000-8000-000000000083", requestId: "old-request", request: { id: "old-request", state: "DECIDED", currentRevisionId: ids.revision }, revision: { ...decision.revision, supersededAt: new Date("2026-09-02T13:00:00Z"), options: [{ id: "00000000-0000-4000-8000-000000000083" }], request: { ...decision.revision.request, id: "old-request", currentRevisionId: ids.revision } }, applications: [{ ...decision.applications[0], id: "00000000-0000-4000-8000-000000000084" }] }
    const authorityChecksum = investmentAuthorityChecksum(old, old.applications[0].id)
    const revocation = {
      id: "00000000-0000-4000-8000-000000000091", requestId: "revocation-request", workspaceId: ids.workspace,
      revisionId: "00000000-0000-4000-8000-000000000092", optionId: "00000000-0000-4000-8000-000000000093", fingerprint: "e".repeat(64), decidedAt: new Date("2026-09-02T14:00:00Z"),
      request: { id: "revocation-request", state: "DECIDED", currentRevisionId: "00000000-0000-4000-8000-000000000092" },
      revision: { fingerprint: "e".repeat(64), sourceFingerprint: "f".repeat(64), supersededAt: null, packetJson: JSON.stringify({ authorityDecisionId: old.id, authorityReceiptId: old.applications[0].id, authorityChecksum, solution: { id: ids.solution } }), options: [{ id: "00000000-0000-4000-8000-000000000093" }], request: { id: "revocation-request", workspaceId: ids.workspace, gateType: "BUILDING_INVESTMENT_REVOCATION", subjectType: "SOLUTION", subjectId: ids.solution } },
      option: { outcomeClass: "APPROVE", continuationKey: "REVOKE_BUILDING_INVESTMENT" }, applications: [{ id: "00000000-0000-4000-8000-000000000094", status: "APPLIED", continuationKey: "REVOKE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: ids.solution }],
    }
    const db = database({ decisionRecord: { findMany: vi.fn().mockResolvedValueOnce([decision]).mockResolvedValueOnce([revocation]).mockResolvedValueOnce([old]) } })
    const generated = await generateNativeNowPolicy(ids.workspace, db)
    expect(generated.document.workspaces[ids.workspace].investmentDecisions[ids.solution]).toEqual(expect.objectContaining({ authorityRecordId: ids.decision, applicationReceiptId: ids.receipt }))
  })

  it("signs and verifies a content-addressed artifact and active selector reproducibly", async () => {
    const generated = await generateNativeNowPolicy(ids.workspace, database())
    const keys = generateKeyPairSync("ed25519")
    const input = {
      signingKeyId: "test-key", privateKey: keys.privateKey,
      routingFingerprint: nativeRoutingFingerprint,
      generatedAt: "2026-09-02T12:00:00.000Z", validUntil: "2026-09-09T12:00:00.000Z",
      mode: "enforce" as const,
    }
    const db = database()
    const sourceFingerprint = nativePolicyCandidateFingerprint(generated, input.routingFingerprint, input.mode)
    ;(db as never as { decisionRecord: { findUnique: ReturnType<typeof vi.fn> } }).decisionRecord.findUnique.mockResolvedValue({
      ...decision, revision: { ...decision.revision, sourceFingerprint, request: { ...decision.revision.request, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: ids.workspace } },
      option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY" },
      applications: [{ id: ids.receipt, status: "APPLIED", continuationKey: "AUTHORIZE_NOW_POLICY", targetType: "WORKSPACE", targetId: ids.workspace }],
    })
    const one = await generateSignedNativeNowPolicyBundle(ids.workspace, ids.decision, input, db)
    const two = await generateSignedNativeNowPolicyBundle(ids.workspace, ids.decision, input, db)
    expect(one).toEqual(two)
    expect(verifyNativeNowPolicyBundle(one, { "test-key": keys.publicKey }, new Date("2026-09-03T00:00:00Z"), input.routingFingerprint)).toEqual(generated.document)
  })

  it("rejects artifact or selector tampering and expiry", async () => {
    const generated = await generateNativeNowPolicy(ids.workspace, database())
    const keys = generateKeyPairSync("ed25519")
    const input = {
      signingKeyId: "test-key", privateKey: keys.privateKey, routingFingerprint: nativeRoutingFingerprint,
      generatedAt: "2026-09-02T12:00:00.000Z", validUntil: "2026-09-03T12:00:00.000Z",
      mode: "enforce" as const,
    }
    const db = database()
    const sourceFingerprint = nativePolicyCandidateFingerprint(generated, input.routingFingerprint, input.mode)
    ;(db as never as { decisionRecord: { findUnique: ReturnType<typeof vi.fn> } }).decisionRecord.findUnique.mockResolvedValue({
      ...decision, revision: { ...decision.revision, sourceFingerprint, request: { ...decision.revision.request, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: ids.workspace } },
      option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY" },
      applications: [{ id: ids.receipt, status: "APPLIED", continuationKey: "AUTHORIZE_NOW_POLICY", targetType: "WORKSPACE", targetId: ids.workspace }],
    })
    const bundle = await generateSignedNativeNowPolicyBundle(ids.workspace, ids.decision, input, db)
    const tampered = structuredClone(bundle)
    tampered.selector.artifactId = `now-policy:v1:sha256:${"f".repeat(64)}`
    expect(() => verifyNativeNowPolicyBundle(tampered, { "test-key": keys.publicKey }, new Date("2026-09-03T00:00:00Z"), nativeRoutingFingerprint)).toThrowError(expect.objectContaining({ code: "POLICY_SIGNATURE_INVALID" }))
    expect(() => verifyNativeNowPolicyBundle(bundle, { "test-key": keys.publicKey }, new Date("2026-09-04T00:00:00Z"), nativeRoutingFingerprint)).toThrowError(expect.objectContaining({ code: "POLICY_EXPIRED" }))
  })

  it("rejects a validly signed bundle whose redundant policy claim diverges from canonical", async () => {
    const generated = await generateNativeNowPolicy(ids.workspace, database())
    const keys = generateKeyPairSync("ed25519"), routing = nativeRoutingFingerprint
    const db = database(), sourceFingerprint = nativePolicyCandidateFingerprint(generated, routing, "enforce")
    ;(db as never as { decisionRecord: { findUnique: ReturnType<typeof vi.fn> } }).decisionRecord.findUnique.mockResolvedValue({ ...decision, revision: { ...decision.revision, sourceFingerprint, request: { ...decision.revision.request, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: ids.workspace } }, option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY" }, applications: [{ id: ids.receipt, status: "APPLIED", continuationKey: "AUTHORIZE_NOW_POLICY", targetType: "WORKSPACE", targetId: ids.workspace }] })
    const bundle = await generateSignedNativeNowPolicyBundle(ids.workspace, ids.decision, { signingKeyId: "test-key", privateKey: keys.privateKey, routingFingerprint: routing, generatedAt: "2026-09-02T12:00:00.000Z", validUntil: "2026-09-09T12:00:00.000Z", mode: "enforce" }, db)
    bundle.artifact.portfolioPolicy.policyId = "forged-policy"
    const payload = Object.fromEntries(Object.entries(bundle.artifact).filter(([key]) => key !== "artifactId"))
    bundle.artifact.artifactId = `now-policy:v1:sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`
    bundle.selector.artifactId = bundle.artifact.artifactId
    bundle.artifactSignature = sign(null, Buffer.from(JSON.stringify(bundle.artifact)), keys.privateKey).toString("base64")
    bundle.selectorSignature = sign(null, Buffer.from(JSON.stringify(bundle.selector)), keys.privateKey).toString("base64")
    expect(() => verifyNativeNowPolicyBundle(bundle, { "test-key": keys.publicKey }, new Date("2026-09-03T00:00:00Z"), routing)).toThrowError(expect.objectContaining({ code: "POLICY_BINDING_INVALID" }))
  })

  it("refuses to sign an artifact generated beyond the allowed clock skew", async () => {
    const generated = await generateNativeNowPolicy(ids.workspace, database())
    const keys = generateKeyPairSync("ed25519"), routing = nativeRoutingFingerprint
    const db = database(), sourceFingerprint = nativePolicyCandidateFingerprint(generated, routing, "enforce")
    ;(db as never as { decisionRecord: { findUnique: ReturnType<typeof vi.fn> } }).decisionRecord.findUnique.mockResolvedValue({ ...decision, revision: { ...decision.revision, sourceFingerprint, request: { ...decision.revision.request, gateType: "NOW_POLICY_ACTIVATION", subjectType: "WORKSPACE", subjectId: ids.workspace } }, option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_NOW_POLICY" }, applications: [{ id: ids.receipt, status: "APPLIED", continuationKey: "AUTHORIZE_NOW_POLICY", targetType: "WORKSPACE", targetId: ids.workspace }] })
    const future = Date.now() + 10 * 60_000
    await expect(generateSignedNativeNowPolicyBundle(ids.workspace, ids.decision, { signingKeyId: "test-key", privateKey: keys.privateKey, routingFingerprint: routing, generatedAt: new Date(future).toISOString(), validUntil: new Date(future + 24 * 60 * 60_000).toISOString(), mode: "enforce" }, db)).rejects.toEqual(expect.objectContaining({ code: "INVALID_SIGNING_INPUT" }))
  })
})
