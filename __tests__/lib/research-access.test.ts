import { beforeEach, describe, expect, it, vi } from "vitest"

const participantToken = { findUnique: vi.fn(), update: vi.fn() }
vi.mock("@/lib/db", () => ({
  default: () => ({ researchParticipantToken: participantToken }),
}))

import { findResearchTokenWorkspaceId, resolveActiveResearchStudy, resolveResearchVoiceCleanupStudy } from "@/lib/research-access"
import { setModules } from "../helpers/modules"
import { hashResearchToken } from "@/lib/research"

describe("resolveActiveResearchStudy", () => {
  beforeEach(() => vi.clearAllMocks())

  it("fails closed while the study's workspace has research capture off, without recording use", async () => {
    setModules({ research_capture: false })
    participantToken.findUnique.mockResolvedValue({
      id: "token-1", kind: "PRIMARY", expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
      study: { id: "study-1", workspaceId: "workspace-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" },
    })

    await expect(resolveActiveResearchStudy("raw-token")).resolves.toBeNull()
    expect(participantToken.update).not.toHaveBeenCalled()
  })

  it("fails the cleanup resolver closed while the study's workspace has research capture off", async () => {
    setModules({ research_capture: false })
    participantToken.findUnique.mockResolvedValue({
      id: "token-1", kind: "PRIMARY",
      study: { id: "study-1", workspaceId: "workspace-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" },
    })

    await expect(resolveResearchVoiceCleanupStudy("raw-token")).resolves.toBeNull()
  })

  it("resolves an active, unexpired, unrevoked participant token and records use", async () => {
    const study = { id: "study-1", workspaceId: "workspace-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" }
    participantToken.findUnique.mockResolvedValue({
      id: "token-1",
      kind: "PRIMARY",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      study,
    })
    participantToken.update.mockResolvedValue({})

    const resolved = await resolveActiveResearchStudy("raw-token")

    expect(participantToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tokenHash: hashResearchToken("raw-token") },
    }))
    expect(resolved).toMatchObject({ study, participantToken: { id: "token-1" } })
    expect(participantToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1), revokedAt: null, study: { status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" } }],
    ["revoked", { expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(), study: { status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" } }],
    ["closed study", { expiresAt: new Date(Date.now() + 60_000), revokedAt: null, study: { status: "CLOSED", studyType: "CUSTOMER_INTERVIEW" } }],
  ])("rejects a %s participant token", async (_label, row) => {
    participantToken.findUnique.mockResolvedValue({ id: "token-1", kind: "PRIMARY", ...row })

    await expect(resolveActiveResearchStudy("raw-token")).resolves.toBeNull()
    expect(participantToken.update).not.toHaveBeenCalled()
  })

  it("rejects a token at the exact expiry boundary", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-30T12:00:00.000Z")
    vi.setSystemTime(now)
    participantToken.findUnique.mockResolvedValue({
      id: "token-1",
      kind: "PRIMARY",
      expiresAt: now,
      revokedAt: null,
      study: { id: "study-1", workspaceId: "workspace-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" },
    })

    await expect(resolveActiveResearchStudy("raw-token")).resolves.toBeNull()
    vi.useRealTimers()
  })

  it("accepts an unexpired LEGACY_HELIO token through the same restricted contract", async () => {
    participantToken.findUnique.mockResolvedValue({
      id: "legacy-token-1",
      kind: "LEGACY_HELIO",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      study: { id: "study-1", workspaceId: "workspace-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" },
    })
    participantToken.update.mockResolvedValue({})

    await expect(resolveActiveResearchStudy("legacy-raw-token")).resolves.toMatchObject({
      participantToken: { id: "legacy-token-1", kind: "LEGACY_HELIO" },
    })
  })

  it("does not fail a valid request when last-used bookkeeping conflicts", async () => {
    const study = { id: "study-1", workspaceId: "workspace-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW" }
    participantToken.findUnique.mockResolvedValue({
      id: "token-1",
      kind: "PRIMARY",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      study,
    })
    participantToken.update.mockRejectedValue(Object.assign(new Error("write conflict"), { code: "P2034" }))

    await expect(resolveActiveResearchStudy("raw-token")).resolves.toMatchObject({ study })
  })

  it("rejects an internal token for a PM interview", async () => {
    participantToken.findUnique.mockResolvedValue({
      id: "internal-token",
      kind: "PM_INTERNAL",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      study: { id: "study-pm", status: "ACTIVE", studyType: "PM_INTERVIEW" },
    })

    await expect(resolveActiveResearchStudy("copied-token")).resolves.toBeNull()
    expect(participantToken.update).not.toHaveBeenCalled()
  })

  it("rejects an internal PM token even on the public cleanup-only resolver", async () => {
    participantToken.findUnique.mockResolvedValue({
      id: "internal-token", kind: "PM_INTERNAL",
      study: { id: "study-pm", status: "ACTIVE", studyType: "PM_INTERVIEW" },
    })

    await expect(resolveResearchVoiceCleanupStudy("copied-token")).resolves.toBeNull()
  })
})

describe("findResearchTokenWorkspaceId", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the study's workspace by token hash, whatever the token's status", async () => {
    participantToken.findUnique.mockResolvedValue({ study: { workspaceId: "workspace-9" } })
    await expect(findResearchTokenWorkspaceId("raw-token")).resolves.toBe("workspace-9")
    expect(participantToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hashResearchToken("raw-token") } }))
  })

  it("returns null for an unknown token", async () => {
    participantToken.findUnique.mockResolvedValue(null)
    await expect(findResearchTokenWorkspaceId("nope")).resolves.toBeNull()
  })
})
