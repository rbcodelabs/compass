import { describe, expect, it, vi } from "vitest"
import { configureWorkspaceCapabilityPack } from "@/lib/capability-pack-service"
import { normalizeCapabilityPack } from "@/lib/capability-pack"
const { unavailableStorage } = vi.hoisted(() => ({ unavailableStorage: vi.fn(() => { throw new Error("Storage unavailable") }) }))
vi.mock("@/lib/artifact-storage", () => ({ getCapabilityPackArtifactStorage: unavailableStorage }))

function pack(body = "Instructions", assets: Array<[string, Uint8Array]> = []) {
  return normalizeCapabilityPack(new Map([
    ["compass-pack.json", Buffer.from(JSON.stringify({ schemaVersion: 1, id: "sample", displayName: "Sample", version: "1.0.0", sdkCompatibility: "0.3.224", requiredHostCapabilities: [], skills: ["a", "b"].map((id) => ({ id, path: `skills/${id}/SKILL.md` })) }))],
    ["skills/a/SKILL.md", Buffer.from(`---\nname: a\ndescription: sample\n---\n${body}`)],
    ["skills/b/SKILL.md", Buffer.from("---\nname: b\ndescription: sample\n---\nInstructions")],
    ...assets,
  ]))
}

describe("workspace capability-pack configuration", () => {
  it("scopes the attachment to the supplied workspace and persists sorted unique skills", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "attachment" })
    const artifact = pack()
    const prisma = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue({ id: "v1", capabilityPackId: "p1", semanticVersion: "1.0.0", capabilityPack: { workspaceId: "ws-1", packId: "sample" }, artifactSha256: artifact.digest, artifactPathname: "sample.json", validationStatus: "VALID", manifestJson: JSON.stringify(artifact.manifest) }) }, workspaceCapabilityPack: { upsert } }
    await configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "v1", enabledSkillIds: ["b", "a", "a"], enabled: true }, prisma as never, { get: async () => artifact.bytes })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_capabilityPackId: { workspaceId: "ws-1", capabilityPackId: "p1" } },
      update: expect.objectContaining({ enabledSkillIds: '["a","b"]' }),
    }))
  })

  it("does not enable a pack whose selected skill requires an unsupported binary asset", async () => {
    const artifact = pack("![image](sample.png)", [["skills/a/sample.png", Buffer.from("png")]])
    const prisma = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue({ id: "v1", capabilityPackId: "p1", semanticVersion: "1.0.0", capabilityPack: { workspaceId: "ws-1", packId: "sample" }, artifactSha256: artifact.digest, artifactPathname: "sample.json", validationStatus: "VALID", manifestJson: JSON.stringify(artifact.manifest) }) }, workspaceCapabilityPack: { upsert: vi.fn() } }
    await expect(configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "v1", enabledSkillIds: ["a"], enabled: true }, prisma as never, { get: async () => artifact.bytes })).rejects.toThrow(/unsupported.*asset/i)
    expect(prisma.workspaceCapabilityPack.upsert).not.toHaveBeenCalled()
  })

  it("allows disabling a pack even when its stored artifact is unavailable", async () => {
    const artifact = pack()
    const storage = { get: vi.fn().mockResolvedValue(null) }
    const prisma = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue({ id: "v1", capabilityPackId: "p1", validationStatus: "VALID", manifestJson: JSON.stringify(artifact.manifest) }) }, workspaceCapabilityPack: { upsert: vi.fn() } }
    await configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "v1", enabledSkillIds: ["a"], enabled: false }, prisma as never, storage)
    expect(storage.get).not.toHaveBeenCalled()
    expect(prisma.workspaceCapabilityPack.upsert).toHaveBeenCalled()
    await configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "v1", enabledSkillIds: ["a"], enabled: false }, prisma as never)
    expect(unavailableStorage).not.toHaveBeenCalled()
  })

  it("rejects invalid versions and skills outside the selected immutable version", async () => {
    const missing = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue(null) } }
    await expect(configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "nope", enabledSkillIds: [], enabled: true }, missing as never)).rejects.toThrow(/validated/i)
    const prisma = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue({ id: "v1", capabilityPackId: "p1", validationStatus: "VALID", manifestJson: JSON.stringify({ sdkCompatibility: "0.3.224", requiredHostCapabilities: ["compass.product_state"], skills: [{ id: "a" }] }), capabilityPack: { workspaceId: "ws-1" } }) }, workspaceCapabilityPack: { upsert: vi.fn() } }
    await expect(configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "v1", enabledSkillIds: ["other"], enabled: true }, prisma as never)).rejects.toThrow(/not declared/i)
  })

  it("cannot attach a version installed for another workspace", async () => {
    const prisma = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue(null) }, workspaceCapabilityPack: { upsert: vi.fn() } }
    await expect(configureWorkspaceCapabilityPack({ workspaceId: "ws-other", packVersionId: "v1", enabledSkillIds: [], enabled: true }, prisma as never)).rejects.toThrow(/validated/i)
    expect(prisma.capabilityPackVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "v1", capabilityPack: { workspaceId: "ws-other" } }) }))
  })
})
