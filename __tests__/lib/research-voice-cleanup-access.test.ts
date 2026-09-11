import { afterEach, expect, it, vi } from "vitest"
const findUnique = vi.hoisted(() => vi.fn())
vi.mock("@/lib/db", () => ({ default: () => ({ researchParticipantToken: { findUnique } }) }))
import { resolveResearchVoiceCleanupStudy } from "@/lib/research-access"
import { hashResearchToken } from "@/lib/research"

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })
it("resolves cleanup only through the original hashed token without an active-link write", async () => {
  vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "1")
  const study = { id: "study", workspaceId: "workspace", status: "CLOSED", studyType: "CUSTOMER_INTERVIEW" }
  const participantToken = { id: "token", kind: "PRIMARY", study, revokedAt: new Date(), expiresAt: new Date(0) }
  findUnique.mockResolvedValueOnce(participantToken).mockResolvedValueOnce(null)
  expect(await resolveResearchVoiceCleanupStudy("original-secret")).toMatchObject({ study, participantToken })
  expect(findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashResearchToken("original-secret") }, include: { study: true } })
  expect(await resolveResearchVoiceCleanupStudy("wrong-token")).toBeNull()
})
