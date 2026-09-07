import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ResearchVoiceError,
  appendFinalResearchVoiceEvent,
  buildCustomerInterviewVoiceInstructions,
  buildGuidedUxVoiceInstructions,
  createResearchVoiceLease,
  releaseResearchVoiceLease,
} from "@/lib/research-voice"
import { hashResearchResumeToken } from "@/lib/research-session"
import { MAX_RESEARCH_TRANSCRIPT_CHARS, MAX_RESEARCH_TURNS } from "@/lib/research-session"

function fixture() {
  const prisma = {
    researchSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    researchTurn: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }) => data),
    },
    researchVoiceEvent: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      create: vi.fn().mockImplementation(async ({ data }) => data),
    },
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
  beforeEach(() => {
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("rejects every legacy voice operation while authoritative voice is disabled", async () => {
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "")
    const { prisma, context } = fixture()
    const common = { context: context as never, sessionId: "session-1", resumeToken: "resume-secret" }

    await expect(createResearchVoiceLease(common)).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    await expect(appendFinalResearchVoiceEvent({
      ...common,
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "disabled-event",
      role: "PARTICIPANT",
      content: "blocked",
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    await expect(releaseResearchVoiceLease({
      ...common,
      leaseId: "00000000-0000-4000-8000-000000000001",
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    expect(prisma.researchSession.findFirst).not.toHaveBeenCalled()
    expect(prisma.researchSession.updateMany).not.toHaveBeenCalled()
  })

  it("rejects every legacy voice operation in production even when all flags are enabled", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "1")
    const { prisma, context } = fixture()
    Object.assign(context.study, { studyType: "CUSTOMER_INTERVIEW", appUrl: null })
    const common = { context: context as never, sessionId: "session-1", resumeToken: "resume-secret" }

    await expect(createResearchVoiceLease(common)).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    await expect(appendFinalResearchVoiceEvent({
      ...common,
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "production-disabled-event",
      role: "PARTICIPANT",
      content: "blocked",
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    await expect(releaseResearchVoiceLease({
      ...common,
      leaseId: "00000000-0000-4000-8000-000000000001",
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    expect(prisma.researchSession.findFirst).not.toHaveBeenCalled()
    expect(prisma.researchSession.updateMany).not.toHaveBeenCalled()
  })
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

  it("authors discovery instructions without usability or app assumptions", () => {
    const prompt = buildCustomerInterviewVoiceInstructions({
      studyName: "Planning habits",
      goal: "Understand weekly planning",
      questions: ["Tell me about the last time you planned your week."],
      targetMinutes: 20,
      transcript: [],
    })
    expect(prompt).toContain("customer discovery interview")
    expect(prompt).toContain("Tell me about the last time")
    expect(prompt).toContain("one question at a time")
    expect(prompt).not.toContain("live product")
    expect(prompt).not.toContain("UI controls")
  })

  it("creates a customer-discovery lease with discovery instructions", async () => {
    const { prisma, context } = fixture()
    Object.assign(context.study, { studyType: "CUSTOMER_INTERVIEW", appUrl: null })
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", modality: "VOICE", nextSequence: 0,
      voiceLeaseId: null, voiceLeaseExpiresAt: null, turns: [],
    })
    const result = await createResearchVoiceLease({ context: context as never, sessionId: "session-1", resumeToken: "resume-secret" })
    expect(result.instructions).toContain("customer discovery interview")
    expect(result.instructions).not.toContain("live product")
  })

  it("rejects every customer-discovery voice operation when its production rollout gate is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "")
    try {
      const { prisma, context } = fixture()
      Object.assign(context.study, { studyType: "CUSTOMER_INTERVIEW", appUrl: null })
      await expect(createResearchVoiceLease({ context: context as never, sessionId: "session-1", resumeToken: "resume-secret" }))
        .rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
      await expect(appendFinalResearchVoiceEvent({
        context: context as never,
        sessionId: "session-1",
        resumeToken: "resume-secret",
        leaseId: "00000000-0000-4000-8000-000000000001",
        providerEventId: "disabled-discovery-event",
        role: "PARTICIPANT",
        content: "blocked",
      })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
      await expect(releaseResearchVoiceLease({
        context: context as never,
        sessionId: "session-1",
        resumeToken: "resume-secret",
        leaseId: "00000000-0000-4000-8000-000000000001",
      })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
      expect(prisma.researchSession.findFirst).not.toHaveBeenCalled()
      expect(prisma.researchSession.updateMany).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
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

  it("rejects a corrupt guide before acquiring a voice lease", async () => {
    const { prisma, context } = fixture()
    context.study.guide = "not-json"
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", modality: "VOICE", nextSequence: 0,
      voiceLeaseId: null, voiceLeaseExpiresAt: null, turns: [],
    })
    await expect(createResearchVoiceLease({ context: context as never, sessionId: "session-1", resumeToken: "resume-secret" }))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    expect(prisma.researchSession.updateMany).not.toHaveBeenCalled()
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

  it("accepts the last canonical voice turn and rejects the first turn over the limit", async () => {
    const accepted = fixture()
    accepted.prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: MAX_RESEARCH_TURNS - 1 })
    accepted.prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: MAX_RESEARCH_TURNS - 1, status: "IN_PROGRESS" })
    accepted.prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    accepted.prisma.researchTurn.findMany.mockResolvedValue(
      Array.from({ length: MAX_RESEARCH_TURNS - 1 }, () => ({ content: "x" })),
    )
    await expect(appendFinalResearchVoiceEvent({
      context: accepted.context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "last-accepted",
      role: "PARTICIPANT",
      content: "accepted",
    })).resolves.toMatchObject({ replayed: false })

    const rejected = fixture()
    rejected.prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: MAX_RESEARCH_TURNS })
    rejected.prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: MAX_RESEARCH_TURNS, status: "IN_PROGRESS" })
    rejected.prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    rejected.prisma.researchTurn.findMany.mockResolvedValue(
      Array.from({ length: MAX_RESEARCH_TURNS }, () => ({ content: "x" })),
    )
    await expect(appendFinalResearchVoiceEvent({
      context: rejected.context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "first-rejected",
      role: "PARTICIPANT",
      content: "rejected",
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
    expect(rejected.prisma.researchSession.updateMany).not.toHaveBeenCalled()
  })

  it("accepts the last transcript characters and rejects the first character over the limit", async () => {
    const accepted = fixture()
    accepted.prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: 1 })
    accepted.prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: 1, status: "IN_PROGRESS" })
    accepted.prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    accepted.prisma.researchTurn.findMany.mockResolvedValue([{ content: "x".repeat(MAX_RESEARCH_TRANSCRIPT_CHARS - 1) }])
    await expect(appendFinalResearchVoiceEvent({
      context: accepted.context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "last-character",
      role: "PARTICIPANT",
      content: "x",
    })).resolves.toMatchObject({ replayed: false })

    const rejected = fixture()
    rejected.prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: 1 })
    rejected.prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: 1, status: "IN_PROGRESS" })
    rejected.prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    rejected.prisma.researchTurn.findMany.mockResolvedValue([{ content: "x".repeat(MAX_RESEARCH_TRANSCRIPT_CHARS) }])
    await expect(appendFinalResearchVoiceEvent({
      context: rejected.context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "over-character-limit",
      role: "PARTICIPANT",
      content: "x",
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceError>)
  })

  it("allows only one concurrent event at the final turn boundary", async () => {
    const { prisma, context } = fixture()
    let nextSequence = MAX_RESEARCH_TURNS - 1
    const contents = Array.from({ length: MAX_RESEARCH_TURNS - 1 }, () => ({ content: "x" }))
    prisma.researchSession.findFirst.mockImplementation(async () => ({ id: "session-1", nextSequence }))
    prisma.researchSession.findUnique.mockImplementation(async () => ({ nextSequence, status: "IN_PROGRESS" }))
    prisma.researchTurn.findMany.mockImplementation(async () => [...contents])
    prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    prisma.researchSession.updateMany.mockImplementation(async ({ where, data }: {
      where: { nextSequence: number }, data: { nextSequence: number }
    }) => {
      if (where.nextSequence !== nextSequence) return { count: 0 }
      nextSequence = data.nextSequence
      return { count: 1 }
    })

    const results = await Promise.allSettled(["concurrent-a", "concurrent-b"].map((providerEventId) =>
      appendFinalResearchVoiceEvent({
        context: context as never,
        sessionId: "session-1",
        resumeToken: "resume-secret",
        leaseId: "00000000-0000-4000-8000-000000000001",
        providerEventId,
        role: "PARTICIPANT",
        content: providerEventId,
      })))

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
    ])
    expect(nextSequence).toBe(MAX_RESEARCH_TURNS)
  })

  it("accepts the last per-minute voice event and rejects the first over the ingress limit", async () => {
    const accepted = fixture()
    accepted.prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: 3 })
    accepted.prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: 3, status: "IN_PROGRESS" })
    accepted.prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    accepted.prisma.researchVoiceEvent.count.mockResolvedValue(29)
    await expect(appendFinalResearchVoiceEvent({
      context: accepted.context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "last-rate-slot",
      role: "PARTICIPANT",
      content: "within the rate",
    })).resolves.toMatchObject({ replayed: false })

    const rejected = fixture()
    rejected.prisma.researchSession.findFirst.mockResolvedValue({ id: "session-1", nextSequence: 3 })
    rejected.prisma.researchSession.findUnique.mockResolvedValue({ nextSequence: 3, status: "IN_PROGRESS" })
    rejected.prisma.researchVoiceEvent.findUnique.mockResolvedValue(null)
    rejected.prisma.researchVoiceEvent.count.mockResolvedValue(30)

    await expect(appendFinalResearchVoiceEvent({
      context: rejected.context as never,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      leaseId: "00000000-0000-4000-8000-000000000001",
      providerEventId: "rate-limited",
      role: "PARTICIPANT",
      content: "too fast",
    })).rejects.toMatchObject({ status: 429 } satisfies Partial<ResearchVoiceError>)
    expect(rejected.prisma.researchSession.updateMany).not.toHaveBeenCalled()
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
