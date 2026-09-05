import { describe, expect, it, vi } from "vitest"
import { configureWorkspaceCapabilityPack } from "@/lib/capability-pack-service"

describe("workspace capability-pack configuration", () => {
  it("scopes the attachment to the supplied workspace and persists sorted unique skills", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "attachment" })
    const prisma = { capabilityPackVersion: { findFirst: vi.fn().mockResolvedValue({ id: "v1", capabilityPackId: "p1", validationStatus: "VALID", manifestJson: JSON.stringify({ sdkCompatibility: ">=0.3.224 <0.4.0", requiredHostCapabilities: ["compass.product_state"], skills: [{ id: "a" }, { id: "b" }] }), capabilityPack: { workspaceId: "ws-1" } }) }, workspaceCapabilityPack: { upsert } }
    await configureWorkspaceCapabilityPack({ workspaceId: "ws-1", packVersionId: "v1", enabledSkillIds: ["b", "a", "a"], enabled: true }, prisma as never)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_capabilityPackId: { workspaceId: "ws-1", capabilityPackId: "p1" } },
      update: expect.objectContaining({ enabledSkillIds: '["a","b"]' }),
    }))
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
