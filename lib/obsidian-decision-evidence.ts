import { verify } from "node:crypto"
import type { ObsidianInvestmentVerifier, ObsidianInvestmentReference } from "@/lib/now-eligibility"

const SHA256 = /^[0-9a-f]{64}$/i
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const DECISION_ROOT = "Products/Compass/Reviews/Decisions/"

export function canonicalObsidianAttestation(input: {
  workspaceId: string
  solutionId: string
  reference: ObsidianInvestmentReference
}): string {
  const { reference } = input
  return JSON.stringify({
    verifierVersion: reference.verifierVersion,
    routingFingerprint: reference.routingFingerprint,
    authorityProvider: "OBSIDIAN",
    authorityRecordId: reference.authorityRecordId,
    authorityLocator: reference.authorityLocator,
    authorityChecksum: reference.authorityChecksum,
    sourceFileSha256: reference.sourceFileSha256,
    workspaceId: input.workspaceId,
    subjectType: "SOLUTION",
    subjectId: input.solutionId,
    decisionOutcome: "APPROVE_BUILDING",
    decisionSourceVersion: reference.decisionSourceVersion,
    applicationStatus: "APPLIED",
    applicationReceiptId: reference.applicationReceiptId,
    appliedAt: reference.appliedAt,
    verifiedAt: reference.verifiedAt,
    signingKeyId: reference.signingKeyId,
  })
}

function configuredPublicKeys(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(process.env.NOW_DECISION_PUBLIC_KEYS_JSON ?? "")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid keys")
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

export const configuredObsidianInvestmentVerifier: ObsidianInvestmentVerifier = {
  async verify(input) {
    const reference = input.reference
    if (!reference.authorityLocator.startsWith(DECISION_ROOT)
      || reference.authorityLocator.includes("..") || reference.authorityLocator.startsWith("/")
      || !SHA256.test(reference.authorityChecksum) || !SHA256.test(reference.sourceFileSha256)
      || !reference.routingFingerprint.startsWith("sha256:") || !SHA256.test(reference.routingFingerprint.slice(7))
      || !RFC3339.test(reference.appliedAt) || !RFC3339.test(reference.verifiedAt)
      || !reference.verifierVersion || !reference.decisionSourceVersion || !reference.signingKeyId
      || !reference.attestationSignature) return false
    const publicKey = configuredPublicKeys()[reference.signingKeyId]
    if (!publicKey) return false
    try {
      return verify(null, Buffer.from(canonicalObsidianAttestation(input)), publicKey, Buffer.from(reference.attestationSignature, "base64"))
    } catch {
      return false
    }
  },
}
