import { describe, expect, it, vi } from "vitest"
import {
  ResearchVoiceError,
  appendFinalResearchVoiceEvent,
  buildGuidedUxVoiceInstructions,
  createResearchVoiceLease,
} from "@/lib/research-voice"
import { hashResearchResumeToken } from "@/lib/research-session"

function fixture() {
  const prisma = {
    researchSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    researchTurn: { create: vi.fn().mockImplementation(async ({ data }) => data) },
    researchVoiceEvent: { findUnique: vi.fn(), create: vi.fn().mockImplementation(async ({ data }) => data) },
    researchAttachment: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(),
  // Test double spans generated Prisma delegate shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as Record<string, any>
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma))
  const study = {
    id: "study-1", workspaceId: "workspace-1", studyType: "USABILITY_TEST",
    name: "Pricing test", goal: "Learn pricing", appUrl: "https://example.com",
    guide: JSON.stringify([{ id: "1", text: "Find a plan for your team." }]), targetMinutes: 15,
  }
  const context = { prisma, study, participantToken: { id: "participant-token-1" } }
  return { prisma, context }
}

describe("guided UX realtime voice", () => {
  it("authors neutral tool-free instructions on the server", () => {
    const prompt = buildGuidedUxVoiceInstructions({
      studyName: "Pricing test",
      goal: "Learn pricing",
      tasks: ["Find a plan for your team."],
      targetMinutes: 15,
      appUrl: "https://example.com",
      transcript: [{ role: "PARTICIPANT", content: "I am on pricing." }],
    })
    expect(prompt).toContain("think aloud")
    expect(prompt).toContain("Never name or point to UI controls")
    expect(prompt).toContain("no tools")
    expect(prompt).toContain("Persisted transcript context")
    expect(prompt).not.toContain("Helio")
  })

  it("requires a guided session resume secret and acquires one expiring connection lease", async () => {
    const { prisma, context } = fixture()
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", modality: "VOICE", nextSequence: 0,
      voiceLeaseId: null, voiceLeaseExpiresAt: null, turns: [],
    })

    const startedAt = Date.now()
    const result = await createResearchVoiceLease({
      context: context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
    })

    expect(prisma.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "session-1",
        studyId: "study-1",
        participantTokenId: "participant-token-1",
        resumeTokenHash: hashResearchResumeToken("resume-secret"),
      }),
    }))
    expect(prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { voiceLeaseId: result.leaseId, voiceLeaseExpiresAt: expect.any(Date), lastActiveAt: expect.any(Date), updatedAt: expect.any(Date) },
    }))
    expect(result.expiresAt.getTime() - startedAt).toBeGreaterThanOrEqual(20 * 60 * 1000)
  })

  it("rejects a second active voice connection", async () => {
    const { prisma, context } = fixture()
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", modality: "VOICE", nextSequence: 0,
      voiceLeaseId: "other-lease", voiceLeaseExpiresAt: new Date(Date.now() + 60_000), turns: [],
    })
    await expect(createResearchVoiceLease({ context: context as never, sessionId: "session-1", resumeToken: "resume-secret" }))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
  })

  it("appends only finalized provider events idempotently to the canonical transcript", async () => {
    const { prisma, context } = fixture()
    prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: 4 })
    prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: 4, status: "IN_PROGRESS" })
    prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)

    const result = await appendFinalResearchVoiceEvent({
      context: context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "provider-item-123",
      role: "PARTICIPANT",
      content: "I expected pricing to be here.",
    })

    expect(result).toMatchObject({ replayed: false, turn: { role: "PARTICIPANT", sequence: 4 } })
    expect(prisma.researchTurn.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sessionId: "session-1", sequence: 4 }) })
    expect(prisma.researchVoiceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ providerEventId: "provider-item-123", turnId: expect.any(String) }) })
  })

  it("atomically links a ready session attachment to its finalized participant turn", async () => {
    const { prisma, context } = fixture()
    prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: 4 })
    prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: 4, status: "IN_PROGRESS" })
    prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    prisma.researchAttachment.findFirst.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000009" })

    await appendFinalResearchVoiceEvent({
      context: context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "attachment:00000000-0000-4000-8000-000000000009",
      role: "PARTICIPANT",
      content: "[Participant shared screenshot.png]",
      attachmentId: "00000000-0000-4000-8000-000000000009",
    })

    expect(prisma.researchAttachment.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({
      id: "00000000-0000-4000-8000-000000000009", workspaceId: "workspace-1", studyId: "study-1",
      sessionId: "session-1", status: "READY", turnId: null,
    }) })
    expect(prisma.researchAttachment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000009", turnId: null }),
      data: { turnId: expect.any(String) },
    }))
  })
})
