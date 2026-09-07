import type { PrismaClient } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { deleteParticipantVoiceEvidenceIfPresent } from "@/lib/research-participant-voice-cleanup"
describe("participant evidence owned cleanup", () => {
  it("scopes child deletion to the exact owned workspace", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 })
    await deleteParticipantVoiceEvidenceIfPresent({ researchParticipantVoiceEvent: { deleteMany } } as unknown as PrismaClient, "workspace")
    expect(deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } })
  })
  it("allows pre-049 schema but propagates all other cleanup failures", async () => {
    const deleteMany = vi.fn().mockRejectedValueOnce({ code: "P2021", meta: { modelName: "ResearchParticipantVoiceEvent" } }).mockRejectedValueOnce(new Error("permission denied"))
    const prisma = { researchParticipantVoiceEvent: { deleteMany } } as unknown as PrismaClient
    await expect(deleteParticipantVoiceEvidenceIfPresent(prisma, "workspace")).resolves.toBeUndefined()
    await expect(deleteParticipantVoiceEvidenceIfPresent(prisma, "workspace")).rejects.toThrow("permission denied")
  })
})
