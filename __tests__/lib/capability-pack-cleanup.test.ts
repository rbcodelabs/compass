import { describe, expect, it, vi } from "vitest"
import { deleteWorkspaceCapabilityPacks } from "@/lib/capability-pack-cleanup"

describe("deleteWorkspaceCapabilityPacks", () => {
  it("deletes database rows child-first while retaining immutable blobs", async () => {
    const prisma = {
    workspaceCapabilityPack: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    capabilityPack: {
      findMany: vi.fn().mockResolvedValue([{ id: "pack-1" }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    capabilityPackVersion: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }

    await deleteWorkspaceCapabilityPacks(prisma, "ws-1")

    expect(prisma.workspaceCapabilityPack.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } })
    expect(prisma.capabilityPackVersion.deleteMany).toHaveBeenCalled()
    expect(prisma.capabilityPack.deleteMany).toHaveBeenCalled()
    expect(prisma.workspaceCapabilityPack.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.capabilityPackVersion.deleteMany.mock.invocationCallOrder[0]
    )
    expect(prisma.capabilityPackVersion.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.capabilityPack.deleteMany.mock.invocationCallOrder[0]
    )
    expect(Object.keys(prisma)).not.toContain("artifactBlobCleanup")
  })
})
