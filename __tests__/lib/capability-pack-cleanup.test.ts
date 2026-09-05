import { describe, expect, it, vi } from "vitest"
import { deleteWorkspaceCapabilityPacks } from "@/lib/capability-pack-cleanup"

function setup(options: { shared?: boolean; deleteFails?: boolean } = {}) {
  const pathname = "capability-packs/digest.json"
  const prisma = {
    workspaceCapabilityPack: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    capabilityPack: {
      findMany: vi.fn().mockResolvedValue([{ id: "pack-1" }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    capabilityPackVersion: {
      findMany: vi.fn().mockResolvedValue([{ artifactPathname: pathname }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(options.shared ? { id: "other-version" } : null),
    },
    artifactRevision: { findFirst: vi.fn().mockResolvedValue(null) },
    artifactBlobCleanup: {
      upsert: vi.fn().mockResolvedValue({ id: "cleanup-1" }),
      findMany: vi.fn().mockResolvedValue(
        options.shared ? [] : [{ id: "cleanup-1", blobPathname: pathname, attempts: 0 }]
      ),
      update: vi.fn().mockResolvedValue({ id: "cleanup-1" }),
      delete: vi.fn().mockResolvedValue({ id: "cleanup-1" }),
    },
  }
  const storage = {
    put: vi.fn(),
    get: vi.fn(),
    del: options.deleteFails
      ? vi.fn().mockRejectedValue(new Error("blob unavailable"))
      : vi.fn().mockResolvedValue(undefined),
  }
  return { prisma, storage, pathname }
}

describe("deleteWorkspaceCapabilityPacks", () => {
  it("deletes attachments, versions, and packs before removing an unreferenced blob", async () => {
    const { prisma, storage, pathname } = setup()

    await deleteWorkspaceCapabilityPacks(prisma, "ws-1", storage)

    expect(prisma.workspaceCapabilityPack.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } })
    expect(prisma.capabilityPackVersion.deleteMany).toHaveBeenCalled()
    expect(prisma.capabilityPack.deleteMany).toHaveBeenCalled()
    expect(storage.del).toHaveBeenCalledWith(pathname)
    expect(prisma.artifactBlobCleanup.delete).toHaveBeenCalledWith({ where: { id: "cleanup-1" } })
  })

  it("retains a digest blob while another pack version references it", async () => {
    const { prisma, storage } = setup({ shared: true })

    await deleteWorkspaceCapabilityPacks(prisma, "ws-1", storage)

    expect(prisma.artifactBlobCleanup.upsert).not.toHaveBeenCalled()
    expect(storage.del).not.toHaveBeenCalled()
  })

  it("records a retry instead of failing workspace deletion when blob removal fails", async () => {
    const { prisma, storage } = setup({ deleteFails: true })

    await expect(deleteWorkspaceCapabilityPacks(prisma, "ws-1", storage)).resolves.toBeUndefined()

    expect(prisma.artifactBlobCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({ attempts: 1, lastError: "blob unavailable" }),
    })
  })
})
