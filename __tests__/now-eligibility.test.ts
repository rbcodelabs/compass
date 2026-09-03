import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"

const mockFindPlan = vi.fn()
const mockFindDecision = vi.fn()
const mockFindRevocations = vi.fn()
const mockFindSolution = vi.fn()
vi.mock("@/lib/db", () => ({ default: () => ({ portfolioCapacityPlan: { findUnique: mockFindPlan }, decisionRecord: { findUnique: mockFindDecision, findMany: mockFindRevocations }, solution: { findUnique: mockFindSolution } }) }))

import { investmentAuthorityChecksum, resolveNowCommitmentEligibility } from "@/lib/now-eligibility"
import { buildingInvestmentSourceFingerprint } from "@/lib/building-investment"
import { nativeRoutingFingerprint, nativeRoutingManifestJson } from "@/__tests__/fixtures/native-routing"

const policyKeys = generateKeyPairSync("ed25519")
const routingFingerprint = nativeRoutingFingerprint

const ids = {
  item: "00000000-0000-4000-8000-000000000001", workspace: "00000000-0000-4000-8000-000000000002",
  solution: "00000000-0000-4000-8000-000000000003", squad: "00000000-0000-4000-8000-000000000004",
  plan: "00000000-0000-4000-8000-000000000005", reserved: "00000000-0000-4000-8000-000000000006",
  decision: "00000000-0000-4000-8000-000000000007", revision: "00000000-0000-4000-8000-000000000008",
  option: "00000000-0000-4000-8000-000000000009", receipt: "00000000-0000-4000-8000-00000000000a",
}
const item = { id: ids.item, workspaceId: ids.workspace, solutionId: ids.solution, squadId: ids.squad }
const solution = { id: ids.solution, title: "Native decisions", description: null, status: "VALIDATED", updatedAt: new Date("2026-08-31T11:00:00Z"), opportunity: { id: "00000000-0000-4000-8000-00000000000b", title: "Trusted delivery", workspaceId: ids.workspace } }
const nativeDecision = {
  id: ids.decision, requestId: "request-1", workspaceId: ids.workspace, revisionId: ids.revision, optionId: ids.option, fingerprint: "c".repeat(64), decidedAt: new Date("2026-08-31T12:00:00Z"),
  request: { id: "request-1", state: "DECIDED", currentRevisionId: ids.revision },
  revision: { fingerprint: "c".repeat(64), sourceFingerprint: buildingInvestmentSourceFingerprint(solution), supersededAt: null, options: [{ id: ids.option }], request: { id: "request-1", gateType: "BUILDING_INVESTMENT", subjectType: "SOLUTION", subjectId: ids.solution, workspaceId: ids.workspace } },
  option: { outcomeClass: "APPROVE", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT" },
  applications: [{ id: ids.receipt, status: "APPLIED", continuationKey: "AUTHORIZE_BUILDING_INVESTMENT", targetType: "SOLUTION", targetId: ids.solution }],
}

function validPolicy() {
  return { version: 1, workspaces: { [ids.workspace]: {
    portfolioPolicyId: "portfolio-v1",
    capacity: { planId: ids.plan, planFingerprint: "b".repeat(64), planVersion: 1, unit: "FOCUS_SLOT", availableUnits: 3, requestedUnits: 1, unitsPerNowItem: 1, nowLimit: 3 },
    investmentDecisions: { [ids.solution]: { authorityProvider: "COMPASS_NATIVE", authorityRecordId: ids.decision, authorityChecksum: investmentAuthorityChecksum(nativeDecision, ids.receipt), decisionOutcome: "APPROVE_BUILDING", applicationStatus: "APPLIED", applicationReceiptId: ids.receipt } },
    displacementByRoadmapItemId: {} as Record<string, { itemId: string; destination: "NEXT" | "LATER" }>,
  } } }
}

function signedNativePolicy(policy = validPolicy()) {
  const workspacePolicy = policy.workspaces[ids.workspace]
  const payload = {
    schemaVersion: "compass-now-policy/v1",
    workspaceId: ids.workspace,
    routingFingerprint,
    portfolioPolicy: { policyId: workspacePolicy.portfolioPolicyId, canonical: workspacePolicy },
    capacityPlan: { id: workspacePolicy.capacity.planId, fingerprint: workspacePolicy.capacity.planFingerprint, version: 1, expectedState: "ACTIVE" },
    investmentEvidence: workspacePolicy.investmentDecisions,
    generatedAt: "2026-09-02T12:00:00.000Z",
    validUntil: "2099-09-09T12:00:00.000Z",
    supersedesArtifactId: null,
    activationDecision: { recordId: "00000000-0000-4000-8000-00000000000b", applicationReceiptId: "00000000-0000-4000-8000-00000000000c", checksum: "d".repeat(64) },
    signingKeyId: "test-native-key",
  }
  const artifactId = `now-policy:v1:sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`
  const artifact = { ...payload, artifactId }
  const selector = {
    schemaVersion: "compass-now-policy-selector/v1",
    workspaceId: ids.workspace,
    artifactId,
    mode: "enforce",
    activationDecisionChecksum: payload.activationDecision.checksum,
    supersedesArtifactId: null,
    signingKeyId: "test-native-key",
  }
  return {
    artifact,
    artifactSignature: sign(null, Buffer.from(JSON.stringify(artifact)), policyKeys.privateKey).toString("base64"),
    selector,
    selectorSignature: sign(null, Buffer.from(JSON.stringify(selector)), policyKeys.privateKey).toString("base64"),
  }
}

function configureSignedNativePolicy(policy = validPolicy()) {
  process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(signedNativePolicy(policy))
  process.env.NOW_DECISION_PUBLIC_KEYS_JSON = JSON.stringify({ "test-native-key": policyKeys.publicKey.export({ type: "spki", format: "pem" }).toString() })
  process.env.NOW_DECISION_ROUTING_MANIFEST_JSON = nativeRoutingManifestJson
}

describe("canonical NOW eligibility resolver", () => {
  const original = process.env.NOW_COMMITMENT_POLICY_JSON
  const originalFile = process.env.NOW_COMMITMENT_POLICY_FILE
  const originalKeys = process.env.NOW_DECISION_PUBLIC_KEYS_JSON
  const originalRouting = process.env.NOW_DECISION_ROUTING_FINGERPRINT
  const temporaryDirectories: string[] = []
  beforeEach(() => { vi.clearAllMocks(); delete process.env.NOW_COMMITMENT_POLICY_JSON; delete process.env.NOW_COMMITMENT_POLICY_FILE; delete process.env.NOW_DECISION_PUBLIC_KEYS_JSON; delete process.env.NOW_DECISION_ROUTING_FINGERPRINT; process.env.NOW_DECISION_ROUTING_MANIFEST_JSON = nativeRoutingManifestJson; mockFindDecision.mockResolvedValue(nativeDecision); mockFindRevocations.mockResolvedValue([]); mockFindSolution.mockResolvedValue(solution) })
  afterEach(() => {
    if (original === undefined) delete process.env.NOW_COMMITMENT_POLICY_JSON; else process.env.NOW_COMMITMENT_POLICY_JSON = original
    if (originalFile === undefined) delete process.env.NOW_COMMITMENT_POLICY_FILE; else process.env.NOW_COMMITMENT_POLICY_FILE = originalFile
    if (originalKeys === undefined) delete process.env.NOW_DECISION_PUBLIC_KEYS_JSON; else process.env.NOW_DECISION_PUBLIC_KEYS_JSON = originalKeys
    if (originalRouting === undefined) delete process.env.NOW_DECISION_ROUTING_FINGERPRINT; else process.env.NOW_DECISION_ROUTING_FINGERPRINT = originalRouting
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it("fails closed when product policy configuration is absent", async () => {
    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
  })

  it.each([
    ["unapproved investment", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].decisionOutcome = "REJECT" as "APPROVE_BUILDING" }],
    ["unapplied investment", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].applicationStatus = "PENDING" as "APPLIED" }],
    ["empty authority", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].authorityRecordId = "" }],
    ["forged checksum", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].investmentDecisions[ids.solution].authorityChecksum = "not-a-sha256" }],
    ["noninteger capacity", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.availableUnits = 1.5 }],
    ["negative capacity", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.requestedUnits = -1 }],
    ["wrong capacity unit", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.unit = "STORY_POINT" }],
    ["wrong available slots", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.availableUnits = 4 }],
    ["variable item weight", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.unitsPerNowItem = 2 }],
    ["wrong requested slots", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.requestedUnits = 2 }],
    ["wrong NOW limit", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.nowLimit = 4 }],
    ["invalid plan mapping", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].capacity.planId = "../../plan" }],
    ["open displacement enum", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].displacementByRoadmapItemId = { [ids.item]: { itemId: ids.reserved, destination: "NOW" as "NEXT" } } }],
    ["displacement outside NEXT", (p: ReturnType<typeof validPolicy>) => { p.workspaces[ids.workspace].displacementByRoadmapItemId = { [ids.item]: { itemId: ids.reserved, destination: "LATER" } } }],
  ])("rejects malformed policy: %s", async (_name, mutate) => {
    const policy = validPolicy(); mutate(policy); process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(policy)
    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
    expect(mockFindPlan).not.toHaveBeenCalled()
  })

  it("resolves configured investment from the authoritative workspace capacity plan", async () => {
    configureSignedNativePolicy()
    mockFindPlan.mockResolvedValue({ id: ids.plan, workspaceId: ids.workspace, activeWorkspaceId: ids.workspace, policyId: "portfolio-v1", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, state: "ACTIVE", version: 1, reservations: [{ roadmapItemId: ids.reserved, units: 1 }] })
    await expect(resolveNowCommitmentEligibility(item)).resolves.toEqual(expect.objectContaining({
      portfolioPolicyId: "portfolio-v1",
      investmentDecision: expect.objectContaining({ subjectId: ids.solution, authorityRecordId: ids.decision }),
      capacity: expect.objectContaining({ reservedUnits: 1, reservedRoadmapItemIds: [ids.reserved] }),
    }))
  })

  it("loads a generated policy file without embedding mutable evidence IDs in application source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "compass-now-policy-")); temporaryDirectories.push(directory)
    const policyPath = join(directory, "policy.json")
    const bundle = signedNativePolicy()
    writeFileSync(policyPath, JSON.stringify(bundle))
    process.env.NOW_COMMITMENT_POLICY_FILE = policyPath
    process.env.NOW_DECISION_PUBLIC_KEYS_JSON = JSON.stringify({ "test-native-key": policyKeys.publicKey.export({ type: "spki", format: "pem" }).toString() })
    process.env.NOW_DECISION_ROUTING_FINGERPRINT = routingFingerprint
    mockFindPlan.mockResolvedValue({ id: ids.plan, workspaceId: ids.workspace, activeWorkspaceId: ids.workspace, policyId: "portfolio-v1", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, state: "ACTIVE", version: 1, reservations: [] })

    await expect(resolveNowCommitmentEligibility(item)).resolves.toEqual(expect.objectContaining({ portfolioPolicyId: "portfolio-v1" }))
  })

  it.each([
    ["fabricated decision", null],
    ["cross workspace", { ...nativeDecision, workspaceId: "00000000-0000-4000-8000-000000000099" }],
    ["wrong solution", { ...nativeDecision, revision: { ...nativeDecision.revision, request: { ...nativeDecision.revision.request, subjectId: "00000000-0000-4000-8000-000000000099" } } }],
    ["pending receipt", { ...nativeDecision, applications: [{ ...nativeDecision.applications[0], status: "PENDING" }] }],
    ["superseded revision", { ...nativeDecision, revision: { ...nativeDecision.revision, supersededAt: new Date("2026-08-31T13:00:00Z") } }],
  ])("rejects unverified native investment evidence: %s", async (_name, evidence) => {
    configureSignedNativePolicy()
    mockFindDecision.mockResolvedValue(evidence)
    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "NO_APPLIED_INVESTMENT_DECISION" }))
    expect(mockFindPlan).not.toHaveBeenCalled()
  })

  it("rejects a fabricated canonical checksum", async () => {
    const policy = validPolicy()
    policy.workspaces[ids.workspace].investmentDecisions[ids.solution].authorityChecksum = "f".repeat(64)
    configureSignedNativePolicy(policy)
    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "NO_APPLIED_INVESTMENT_DECISION" }))
  })

  it("rejects an otherwise valid unsigned Compass-native policy", async () => {
    process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(validPolicy())

    await expect(resolveNowCommitmentEligibility(item)).rejects.toEqual(expect.objectContaining({ code: "POLICY_CONFIGURATION_REQUIRED" }))
    expect(mockFindDecision).not.toHaveBeenCalled()
    expect(mockFindPlan).not.toHaveBeenCalled()
  })

  it("fails closed for Obsidian authority when the configured verifier is unavailable", async () => {
    const policy = validPolicy()
    policy.workspaces[ids.workspace].investmentDecisions[ids.solution] = {
      authorityProvider: "OBSIDIAN" as "COMPASS_NATIVE", authorityRecordId: "obsidian-note", authorityChecksum: "a".repeat(64),
      decisionOutcome: "APPROVE_BUILDING", applicationStatus: "APPLIED", applicationReceiptId: "obsidian-receipt",
      authorityLocator: "Products/Compass/Reviews/Decisions/decision.md", decisionSourceVersion: "obsidian-decision/v1",
      appliedAt: "2026-09-02T15:00:00.000Z", verifiedAt: "2026-09-02T15:01:00.000Z",
      verifierVersion: "compass-obsidian-verifier/v1", routingFingerprint: `sha256:${"b".repeat(64)}`,
      sourceFileSha256: "c".repeat(64), signingKeyId: "missing-key", attestationSignature: "dGVzdA==",
    } as typeof policy.workspaces[typeof ids.workspace]["investmentDecisions"][typeof ids.solution] & Record<string, string>
    process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(policy)
    await expect(resolveNowCommitmentEligibility(item, undefined, {})).rejects.toEqual(expect.objectContaining({ code: "NO_APPLIED_INVESTMENT_DECISION" }))
  })

  it("preserves the verified unsigned Obsidian policy compatibility path", async () => {
    const policy = validPolicy()
    policy.workspaces[ids.workspace].investmentDecisions[ids.solution] = {
      authorityProvider: "OBSIDIAN" as "COMPASS_NATIVE", authorityRecordId: "obsidian-note", authorityChecksum: "a".repeat(64),
      decisionOutcome: "APPROVE_BUILDING", applicationStatus: "APPLIED", applicationReceiptId: "obsidian-receipt",
      authorityLocator: "Products/Compass/Reviews/Decisions/decision.md", decisionSourceVersion: "obsidian-decision/v1",
      appliedAt: "2026-09-02T15:00:00.000Z", verifiedAt: "2026-09-02T15:01:00.000Z",
      verifierVersion: "compass-obsidian-verifier/v1", routingFingerprint: `sha256:${"b".repeat(64)}`,
      sourceFileSha256: "c".repeat(64), signingKeyId: "test-key", attestationSignature: "dGVzdA==",
    } as typeof policy.workspaces[typeof ids.workspace]["investmentDecisions"][typeof ids.solution] & Record<string, string>
    process.env.NOW_COMMITMENT_POLICY_JSON = JSON.stringify(policy)
    mockFindPlan.mockResolvedValue({ id: ids.plan, workspaceId: ids.workspace, activeWorkspaceId: ids.workspace, policyId: "portfolio-v1", planFingerprint: "b".repeat(64), unit: "FOCUS_SLOT", availableUnits: 3, unitsPerNowItem: 1, nowLimit: 3, state: "ACTIVE", version: 1, reservations: [] })
    const obsidianVerifier = { verify: vi.fn().mockResolvedValue(true) }

    await expect(resolveNowCommitmentEligibility(item, undefined, { obsidianVerifier })).resolves.toEqual(expect.objectContaining({
      investmentDecision: expect.objectContaining({ authorityProvider: "OBSIDIAN" }),
    }))
  })
})
