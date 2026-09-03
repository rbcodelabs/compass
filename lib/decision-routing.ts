import { createHash } from "node:crypto"
import { constants, closeSync, lstatSync, openSync, readFileSync } from "node:fs"

export class DecisionRoutingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DecisionRoutingError" }
}

export type DecisionRoutingManifest = {
  schemaVersion: "agentic-pm-decision-routing/v1"
  contractVersion: number
  workflowProfile: string
  capability: "decision_records"
  providers: Array<{ provider: string; connectionIdentity: string; reviewRoot: string | null }>
  canonicalizerVersion: "decision-routing-c14n/v1"
}

const exactKeys = (value: object, keys: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

export function resolveDecisionRoutingManifest(value: unknown) {
  if (!value || typeof value !== "object" || !exactKeys(value, ["schemaVersion", "contractVersion", "workflowProfile", "capability", "providers", "canonicalizerVersion"])) {
    throw new DecisionRoutingError("ROUTING_MANIFEST_INVALID", "Decision routing manifest must use the closed v1 schema.")
  }
  const manifest = value as DecisionRoutingManifest
  if (manifest.schemaVersion !== "agentic-pm-decision-routing/v1" || !Number.isSafeInteger(manifest.contractVersion) || manifest.contractVersion < 1
    || !manifest.workflowProfile?.trim() || manifest.capability !== "decision_records" || manifest.canonicalizerVersion !== "decision-routing-c14n/v1"
    || !Array.isArray(manifest.providers) || manifest.providers.length !== 1) {
    throw new DecisionRoutingError("ROUTING_AMBIGUOUS", "Decision routing must resolve to exactly one versioned provider.")
  }
  const provider = manifest.providers[0]
  if (!provider || !exactKeys(provider, ["provider", "connectionIdentity", "reviewRoot"])
    || provider.provider !== "compass_decision_ledger" || !provider.connectionIdentity?.trim() || provider.reviewRoot !== null) {
    throw new DecisionRoutingError("ROUTING_PROVIDER_INVALID", "Native decision policy requires one Compass ledger provider with a canonical connection identity.")
  }
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    contractVersion: manifest.contractVersion,
    workflowProfile: manifest.workflowProfile,
    capability: manifest.capability,
    provider: provider.provider,
    connectionIdentity: provider.connectionIdentity,
    reviewRoot: provider.reviewRoot,
    canonicalizerVersion: manifest.canonicalizerVersion,
  }
  return { canonical, fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}` }
}

export function configuredDecisionRouting() {
  const inline = process.env.NOW_DECISION_ROUTING_MANIFEST_JSON
  const path = process.env.NOW_DECISION_ROUTING_MANIFEST_FILE
  if (inline && path) throw new DecisionRoutingError("ROUTING_MANIFEST_CONFLICT", "Configure exactly one canonical decision routing manifest source.")
  if (inline) return resolveDecisionRoutingManifest(JSON.parse(inline))
  if (!path) throw new DecisionRoutingError("ROUTING_MANIFEST_REQUIRED", "A canonical decision routing manifest file is required.")
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DecisionRoutingError("ROUTING_MANIFEST_INVALID", "Decision routing manifest must be a regular non-symlink file.")
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { return resolveDecisionRoutingManifest(JSON.parse(readFileSync(descriptor, "utf8"))) }
  finally { closeSync(descriptor) }
}
