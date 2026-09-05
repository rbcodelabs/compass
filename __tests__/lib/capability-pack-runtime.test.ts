import { describe, expect, it } from "vitest"
import { normalizeCapabilityPack } from "@/lib/capability-pack"
import { assertPackHostCompatibility, prepareCapabilityPacksForTurn } from "@/lib/capability-pack-runtime"

function pack(id: string, skill = "one") {
  return normalizeCapabilityPack(new Map([
    ["compass-pack.json", new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, id, displayName: id, version: "1.0.0", sdkCompatibility: ">=0.3.224 <0.4.0", skills: [{ id: skill, path: `skills/${skill}/SKILL.md` }], requiredHostCapabilities: ["compass.product_state"] }))],
    [`skills/${skill}/SKILL.md`, new TextEncoder().encode(`---\nname: ${skill}\ndescription: test\n---\ntest`)],
  ]))
}

describe("capability pack turn preparation", () => {
  it("accepts only ranges that actually contain the pinned host and available capabilities", () => {
    expect(() => assertPackHostCompatibility(">=0.3.224 <0.4.0", ["compass.product_state"])).not.toThrow()
    expect(() => assertPackHostCompatibility("0.3.224", ["compass.product_state"])).not.toThrow()
    expect(() => assertPackHostCompatibility(">0.3.224 <0.4.0", ["compass.product_state"])).toThrow(/incompatible/i)
    expect(() => assertPackHostCompatibility(">=0.3.200 <0.3.224", ["compass.product_state"])).toThrow(/incompatible/i)
    expect(() => assertPackHostCompatibility(">=0.4.0", ["compass.product_state"])).toThrow(/incompatible/i)
    expect(() => assertPackHostCompatibility(">=0.3.224 <0.4.0", ["compass.product_state", "github"])).toThrow(/capability/i)
  })
  it("verifies artifacts and emits sandbox files, qualified skills and exact provenance", async () => {
    const artifact = pack("demo")
    const result = await prepareCapabilityPacksForTurn([{
      packId: "demo", version: "1.0.0", commit: "a".repeat(40), digest: artifact.digest,
      pathname: "capability-packs/sha256/x.json", enabledSkills: ["one"], manifestJson: JSON.stringify(artifact.manifest),
    }], { get: async () => artifact.bytes })
    expect(result.pluginPaths).toEqual([`capability-packs/demo-1.0.0-${artifact.digest.slice(0, 12)}`])
    expect(result.skillIds).toEqual(["demo:one"])
    expect(result.files.map((file) => file.path)).toContain(`capability-packs/demo-1.0.0-${artifact.digest.slice(0, 12)}/.claude-plugin/plugin.json`)
    expect(JSON.parse(result.provenanceJson)).toEqual([{ id: "demo", version: "1.0.0", commit: "a".repeat(40), digest: artifact.digest, enabledSkills: ["one"] }])
  })

  it("rejects missing artifacts, undeclared skill selection and cross-pack skill conflicts", async () => {
    const a = pack("a")
    await expect(prepareCapabilityPacksForTurn([{ packId: "a", version: "1.0.0", commit: "a".repeat(40), digest: a.digest, pathname: "x", enabledSkills: ["one"], manifestJson: JSON.stringify(a.manifest) }], { get: async () => null })).rejects.toThrow(/not found/i)
    await expect(prepareCapabilityPacksForTurn([{ packId: "a", version: "1.0.0", commit: "a".repeat(40), digest: a.digest, pathname: "x", enabledSkills: ["other"], manifestJson: JSON.stringify(a.manifest) }], { get: async () => a.bytes })).rejects.toThrow(/not declared/i)
    const b = pack("b")
    await expect(prepareCapabilityPacksForTurn([
      { packId: "a", version: "1.0.0", commit: "a".repeat(40), digest: a.digest, pathname: "a", enabledSkills: ["one"], manifestJson: JSON.stringify(a.manifest) },
      { packId: "b", version: "1.0.0", commit: "b".repeat(40), digest: b.digest, pathname: "b", enabledSkills: ["one"], manifestJson: JSON.stringify(b.manifest) },
    ], { get: async (p) => p === "a" ? a.bytes : b.bytes })).rejects.toThrow(/duplicate skill/i)
  })

  it("caps the aggregate active pack set", async () => {
    const artifact = pack("a")
    const active = Array.from({ length: 6 }, (_, index) => ({ packId: `p${index}`, version: "1.0.0", commit: "a".repeat(40), digest: artifact.digest, pathname: "x", enabledSkills: [], manifestJson: JSON.stringify(artifact.manifest) }))
    await expect(prepareCapabilityPacksForTurn(active, { get: async () => artifact.bytes })).rejects.toThrow(/at most 5/i)
  })
})
