import { resolveDecisionRoutingManifest } from "@/lib/decision-routing"

export const nativeRoutingManifest = {
  schemaVersion: "agentic-pm-decision-routing/v1",
  contractVersion: 2,
  workflowProfile: "compass-native-review",
  capability: "decision_records",
  providers: [{ provider: "compass_decision_ledger", connectionIdentity: "rbcodelabs/compass:3eaf938a-782c-4073-a452-070d54156896", reviewRoot: null }],
  canonicalizerVersion: "decision-routing-c14n/v1",
} as const

export const nativeRoutingManifestJson = JSON.stringify(nativeRoutingManifest)
export const nativeRoutingFingerprint = resolveDecisionRoutingManifest(nativeRoutingManifest).fingerprint
