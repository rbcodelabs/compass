import { afterEach, describe, expect, it } from "vitest"
import { configuredDecisionRouting, resolveDecisionRoutingManifest } from "@/lib/decision-routing"

const manifest = { schemaVersion: "agentic-pm-decision-routing/v1", contractVersion: 2, workflowProfile: "compass-native-review", capability: "decision_records", providers: [{ provider: "compass_decision_ledger", connectionIdentity: "rbcodelabs/compass:3eaf938a-782c-4073-a452-070d54156896", reviewRoot: null }], canonicalizerVersion: "decision-routing-c14n/v1" } as const

describe("decision routing manifest", () => {
  afterEach(() => {
    delete process.env.NOW_DECISION_ROUTING_MANIFEST_JSON
    delete process.env.NOW_DECISION_ROUTING_MANIFEST_FILE
  })
  it("derives a deterministic fingerprint from the resolved canonical route", () => {
    expect(resolveDecisionRoutingManifest(manifest).fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(resolveDecisionRoutingManifest(structuredClone(manifest)).fingerprint).toBe(resolveDecisionRoutingManifest(manifest).fingerprint)
  })

  it("fails closed when routing resolves to zero or multiple providers", () => {
    expect(() => resolveDecisionRoutingManifest({ ...manifest, providers: [] })).toThrowError(expect.objectContaining({ code: "ROUTING_AMBIGUOUS" }))
    expect(() => resolveDecisionRoutingManifest({ ...manifest, providers: [...manifest.providers, manifest.providers[0]] })).toThrowError(expect.objectContaining({ code: "ROUTING_AMBIGUOUS" }))
  })

  it("rejects conflicting providers and open schema claims", () => {
    expect(() => resolveDecisionRoutingManifest({ ...manifest, providers: [{ ...manifest.providers[0], provider: "obsidian" }] })).toThrowError(expect.objectContaining({ code: "ROUTING_PROVIDER_INVALID" }))
    expect(() => resolveDecisionRoutingManifest({ ...manifest, unexpected: true })).toThrowError(expect.objectContaining({ code: "ROUTING_MANIFEST_INVALID" }))
  })

  it("fails closed when two canonical routing sources are configured", () => {
    process.env.NOW_DECISION_ROUTING_MANIFEST_JSON = JSON.stringify(manifest)
    process.env.NOW_DECISION_ROUTING_MANIFEST_FILE = "/unused/conflicting-routing.json"

    expect(() => configuredDecisionRouting()).toThrowError(expect.objectContaining({
      code: "ROUTING_MANIFEST_CONFLICT",
    }))
  })
})
