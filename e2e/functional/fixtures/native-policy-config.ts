import { createHash, createPrivateKey, sign } from "node:crypto";
import { resolveDecisionRoutingManifest } from "../../../lib/decision-routing";

export const E2E_POLICY_KEY_ID = "e2e-native-policy-key";
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIBKAvKc4PJgkE+Xm3DfFRqk9dwgxhWf5C3liv7ypMIAF
-----END PRIVATE KEY-----`;
export const E2E_POLICY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5iCSU/JFk3exglPcuJk6dgUmSZRCmOEXrkrmDzb3DJs=
-----END PUBLIC KEY-----`;
export const E2E_ROUTING_MANIFEST = {
  schemaVersion: "agentic-pm-decision-routing/v1" as const,
  contractVersion: 1,
  workflowProfile: "e2e-compass-native",
  capability: "decision_records" as const,
  providers: [{ provider: "compass_decision_ledger", connectionIdentity: "e2e-local-postgres", reviewRoot: null }],
  canonicalizerVersion: "decision-routing-c14n/v1" as const,
};

export function signedE2ENativePolicy(document: Record<string, unknown>) {
  const workspaceId = Object.keys(document.workspaces as object)[0];
  const canonical = (document.workspaces as Record<string, Record<string, unknown>>)[workspaceId];
  const capacity = canonical.capacity as Record<string, unknown>;
  const activationDecision = { recordId: "00000000-0000-4000-8000-0000000000e1", applicationReceiptId: "00000000-0000-4000-8000-0000000000e2", checksum: "e".repeat(64) };
  const generatedAtMs = Date.now() - 60_000;
  const payload = {
    schemaVersion: "compass-now-policy/v1", workspaceId,
    routingFingerprint: resolveDecisionRoutingManifest(E2E_ROUTING_MANIFEST).fingerprint,
    portfolioPolicy: { policyId: canonical.portfolioPolicyId, canonical },
    capacityPlan: { id: capacity.planId, fingerprint: capacity.planFingerprint, version: capacity.planVersion, expectedState: "ACTIVE" },
    investmentEvidence: canonical.investmentDecisions,
    generatedAt: new Date(generatedAtMs).toISOString(), validUntil: new Date(generatedAtMs + 14 * 24 * 60 * 60_000).toISOString(),
    supersedesArtifactId: null, activationDecision, signingKeyId: E2E_POLICY_KEY_ID,
  };
  const artifactId = `now-policy:v1:sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  const artifact = { ...payload, artifactId };
  const selector = { schemaVersion: "compass-now-policy-selector/v1", workspaceId, artifactId, mode: "enforce", activationDecisionChecksum: activationDecision.checksum, supersedesArtifactId: null, signingKeyId: E2E_POLICY_KEY_ID };
  const key = createPrivateKey(PRIVATE_KEY);
  return { artifact, artifactSignature: sign(null, Buffer.from(JSON.stringify(artifact)), key).toString("base64"), selector, selectorSignature: sign(null, Buffer.from(JSON.stringify(selector)), key).toString("base64") };
}
