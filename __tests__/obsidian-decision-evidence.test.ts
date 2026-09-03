import { afterEach, describe, expect, it } from "vitest"
import { generateKeyPairSync, sign } from "node:crypto"
import {
  canonicalObsidianAttestation,
  configuredObsidianInvestmentVerifier,
} from "@/lib/obsidian-decision-evidence"
import type { ObsidianInvestmentReference } from "@/lib/now-eligibility"

const workspaceId = "00000000-0000-4000-8000-000000000002"
const solutionId = "00000000-0000-4000-8000-000000000003"

function reference(): ObsidianInvestmentReference {
  return {
    authorityProvider: "OBSIDIAN",
    authorityRecordId: "decision-2026-09-02",
    authorityLocator: "Products/Compass/Reviews/Decisions/decision-2026-09-02.md",
    authorityChecksum: "a".repeat(64),
    decisionOutcome: "APPROVE_BUILDING",
    applicationStatus: "APPLIED",
    applicationReceiptId: "receipt-2026-09-02",
    decisionSourceVersion: "obsidian-decision/v1",
    appliedAt: "2026-09-02T15:00:00.000Z",
    verifiedAt: "2026-09-02T15:01:00.000Z",
    verifierVersion: "compass-obsidian-verifier/v1",
    routingFingerprint: `sha256:${"b".repeat(64)}`,
    sourceFileSha256: "c".repeat(64),
    signingKeyId: "test-key",
    attestationSignature: "",
  }
}

describe("configured Obsidian decision evidence verifier", () => {
  const originalKeys = process.env.NOW_DECISION_PUBLIC_KEYS_JSON
  afterEach(() => {
    if (originalKeys === undefined) delete process.env.NOW_DECISION_PUBLIC_KEYS_JSON
    else process.env.NOW_DECISION_PUBLIC_KEYS_JSON = originalKeys
  })

  it("accepts a signed content-addressed attestation from the configured Decisions root", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    process.env.NOW_DECISION_PUBLIC_KEYS_JSON = JSON.stringify({
      "test-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
    })
    const evidence = reference()
    evidence.attestationSignature = sign(
      null,
      Buffer.from(canonicalObsidianAttestation({ workspaceId, solutionId, reference: evidence })),
      privateKey,
    ).toString("base64")

    await expect(configuredObsidianInvestmentVerifier.verify({ workspaceId, solutionId, reference: evidence })).resolves.toBe(true)
  })

  it("rejects an attestation when immutable subject evidence is changed", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    process.env.NOW_DECISION_PUBLIC_KEYS_JSON = JSON.stringify({
      "test-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
    })
    const evidence = reference()
    evidence.attestationSignature = sign(
      null,
      Buffer.from(canonicalObsidianAttestation({ workspaceId, solutionId, reference: evidence })),
      privateKey,
    ).toString("base64")

    await expect(configuredObsidianInvestmentVerifier.verify({ workspaceId, solutionId: "00000000-0000-4000-8000-000000000099", reference: evidence })).resolves.toBe(false)
  })

  it("rejects paths outside the configured Obsidian Decisions root", async () => {
    const evidence = reference()
    evidence.authorityLocator = "Products/Compass/Reviews/../Secrets/decision.md"
    evidence.attestationSignature = Buffer.from("unsigned").toString("base64")
    await expect(configuredObsidianInvestmentVerifier.verify({ workspaceId, solutionId, reference: evidence })).resolves.toBe(false)
  })
})
