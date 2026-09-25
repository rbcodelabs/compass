import { describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { deleteWorkspaceResearchData } from "@/lib/research-workspace-cleanup"

function cleanupClient() {
  const models = [
    "experimentResearchStudyLink", "researchVoiceCommand", "researchVoiceEvent",
    "researchVoiceCall", "researchRequest", "researchAttachment",
    "researchParticipantVoiceEvent", "researchTurn", "pMInterview",
    "researchSession", "researchParticipantToken", "researchSynthesis", "researchStudy",
  ] as const
  const delegates = Object.fromEntries(models.map(name => [name, {
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  }])) as Record<typeof models[number], { deleteMany: ReturnType<typeof vi.fn> }>
  return { delegates, prisma: delegates as unknown as AppPrismaClient }
}

describe("workspace research cleanup", () => {
  it("deletes only this workspace's experiment links before its studies", async () => {
    const { delegates, prisma } = cleanupClient()

    await deleteWorkspaceResearchData(prisma, "workspace-being-deleted")

    expect(delegates.experimentResearchStudyLink.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { workspaceId: "workspace-being-deleted" },
    })
    expect(delegates.researchStudy.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { workspaceId: "workspace-being-deleted" },
    })
    expect(delegates.experimentResearchStudyLink.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(delegates.researchStudy.deleteMany.mock.invocationCallOrder[0])
  })

  it("does not delete studies if removing their experiment links fails", async () => {
    const { delegates, prisma } = cleanupClient()
    delegates.experimentResearchStudyLink.deleteMany.mockRejectedValue(new Error("database unavailable"))

    await expect(deleteWorkspaceResearchData(prisma, "workspace-being-deleted"))
      .rejects.toThrow("database unavailable")

    expect(delegates.researchStudy.deleteMany).not.toHaveBeenCalled()
  })
})
