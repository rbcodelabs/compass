import { describe, expect, it } from "vitest"
import { normalizeCapabilityPack } from "@/lib/capability-pack"
import { prepareCapabilityPacksForTurn } from "@/lib/capability-pack-runtime"

function artifact(body = "ENABLED_BODY_CANARY", assets: Array<[string, Uint8Array]> = []) {
  return normalizeCapabilityPack(new Map([
    ["compass-pack.json", Buffer.from(JSON.stringify({ schemaVersion: 1, id: "sample", displayName: "Sample", version: "1.0.0", sdkCompatibility: "0.3.224", requiredHostCapabilities: [], skills: [{ id: "enabled", path: "skills/enabled/SKILL.md" }, { id: "disabled", path: "skills/disabled/SKILL.md" }] }))],
    ["skills/enabled/SKILL.md", Buffer.from(`---\nname: enabled\ndescription: enabled sample\n---\n${body}`)],
    ["skills/disabled/SKILL.md", Buffer.from("---\nname: disabled\ndescription: hidden sample\n---\nDISABLED_BODY_CANARY")],
    ...assets,
  ]))
}
function prepare(pack: ReturnType<typeof artifact>, enabledSkills = ["enabled"]) {
  return prepareCapabilityPacksForTurn([{ packId: "sample", version: "1.0.0", commit: "a".repeat(40), digest: pack.digest, pathname: "sample.json", enabledSkills, manifestJson: JSON.stringify(pack.manifest) }], { get: async () => pack.bytes })
}
describe("capability instruction compilation", () => {
  it("provides enabled bodies without requiring an SDK Skill or filesystem tool", async () => {
    const result = await prepare(artifact())
    expect(result.systemPromptAppendices.join("\n\n")).toContain("ENABLED_BODY_CANARY")
    expect(result.systemPromptAppendices.join("\n\n")).not.toContain("DISABLED_BODY_CANARY")
  })
  it("inlines and deduplicates directly referenced UTF-8 assets", async () => {
    const result = await prepare(artifact("Read [guide](guide.md) and [guide again](guide.md)", [["skills/enabled/guide.md", Buffer.from("ASSET_CANARY")]]))
    expect(result.systemPromptAppendices.join("\n\n").match(/ASSET_CANARY/g)).toHaveLength(1)
  })
  it("does not leak disabled skill bodies through asset links", async () => {
    await expect(prepare(artifact("Read [hidden](../disabled/SKILL.md)"))).rejects.toThrow(/disabled skill/i)
  })
  it("rejects binary assets rather than claiming the tool-less runtime can inspect them", async () => {
    await expect(prepare(artifact("See ![picture](picture.png)", [["skills/enabled/picture.png", new Uint8Array([137, 80, 78, 71])]]))).rejects.toThrow(/unsupported.*asset/i)
  })
  it("rejects malformed UTF-8 text assets", async () => {
    await expect(prepare(artifact("Read [text](text.txt)", [["skills/enabled/text.txt", new Uint8Array([255])]]))).rejects.toThrow(/UTF-8/i)
  })
  it("rejects compiled context above 64 KiB", async () => {
    await expect(prepare(artifact("x".repeat(64 * 1024)))).rejects.toThrow(/64 KiB/i)
  })
  it("sorts enabled skills for deterministic compilation", async () => {
    const pack = artifact()
    const first = await prepare(pack, ["enabled", "disabled"])
    const second = await prepare(pack, ["disabled", "enabled"])
    expect(first.systemPromptAppendices).toEqual(second.systemPromptAppendices)
  })
  it("shares the 64 KiB budget across active packs", async () => {
    const packs = ["one", "two"].map((id) => normalizeCapabilityPack(new Map([
      ["compass-pack.json", Buffer.from(JSON.stringify({ schemaVersion: 1, id, displayName: id, version: "1.0.0", sdkCompatibility: "0.3.224", requiredHostCapabilities: [], skills: [{ id, path: `skills/${id}/SKILL.md` }] }))],
      [`skills/${id}/SKILL.md`, Buffer.from(`---\nname: ${id}\ndescription: sample\n---\n${"x".repeat(34 * 1024)}`)],
    ])))
    const active = packs.map((pack) => ({ packId: pack.manifest.id, version: "1.0.0", commit: "a".repeat(40), digest: pack.digest, pathname: pack.manifest.id, enabledSkills: [pack.manifest.id], manifestJson: JSON.stringify(pack.manifest) }))
    await expect(prepareCapabilityPacksForTurn(active, { get: async (name) => packs.find((pack) => pack.manifest.id === name)!.bytes }).then(() => null)).rejects.toThrow(/64 KiB/i)
  })
})
