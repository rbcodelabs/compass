import { describe, expect, it, vi } from "vitest"
import {
  MAX_RESEARCH_MESSAGE_CHARS,
  MAX_RESEARCH_INTERVIEWER_CHARS,
  MAX_RESEARCH_SESSION_MS,
  MAX_RESEARCH_TRANSCRIPT_CHARS,
  MAX_RESEARCH_TURNS,
  MAX_RESEARCH_RESPONSES_PER_MINUTE,
  MAX_RESEARCH_STARTS_PER_MINUTE,
  MAX_RESEARCH_TOKEN_RESPONSES_PER_MINUTE,
  MAX_RESEARCH_AGENT_CALLS_PER_DAY,
  RESEARCH_REQUEST_LEASE_MS,
  ResearchSessionError,
  assertResearchAnswer,
  assertResearchInterviewerReply,
  getServerElapsedSeconds,
  hashResearchResumeToken,
  startOrResumeResearchSession,
  respondToResearchSession,
  completeResearchSession,
  reconcileAbandonedResearchSessions,
} from "@/lib/research-session"

function context(overrides: Record<string, unknown> = {}) {
  const prisma = {
    researchParticipantToken: {
      findUnique: vi.fn().mockResolvedValue({
        startWindowAt: null,
        startCount: null,
        responseWindowAt: null,
        responseCount: null,
        agentWindowAt: null,
        agentCallCount: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: "participant-token-1" }),
    },
    researchStudy: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({
        id: "study-1", workspaceId: "workspace-1", name: "Planning", goal: "Understand planning",
        studyType: "CUSTOMER_INTERVIEW", guide: JSON.stringify([{ id: "1", text: "Tell me about the last time." }]),
        targetMinutes: 15, appUrl: null, status: "ACTIVE",
      }),
    },
    researchSession: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, createdAt: new Date() })),
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        status: "IN_PROGRESS",
        activeRequestId: null,
        activeRequestExpiresAt: null,
        nextSequence: 1,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    researchTurn: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, createdAt: new Date() })),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    researchRequest: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    researchAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
    ...overrides,
  // The test double intentionally spans several generated Prisma delegate shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as Record<string, any>
  prisma.$transaction.mockImplementation(async (operation: unknown) => {
    if (Array.isArray(operation)) return Promise.all(operation)
    return (operation as (tx: typeof prisma) => Promise<unknown>)(prisma)
  })
  return {
    prisma,
    value: {
      prisma,
      study: {
        id: "study-1",
        workspaceId: "workspace-1",
        name: "Planning",
        goal: "Understand planning",
        studyType: "CUSTOMER_INTERVIEW",
        guide: JSON.stringify([{ id: "1", text: "Tell me about the last time." }]),
        targetMinutes: 15,
        appUrl: null,
        shareTokenHash: null,
        shareExpiresAt: null,
        status: "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
        createdById: "user-1",
        updatedById: "user-1",
        source: "UI",
      },
      participantToken: { id: "participant-token-1" },
    } as never,
  }
}

describe("research session boundaries", () => {
  it.each([
    ["empty", "", 400],
    ["whitespace", "   ", 400],
    ["non-string", 42, 400],
    ["too long", "x".repeat(MAX_RESEARCH_MESSAGE_CHARS + 1), 413],
  ])("rejects %s participant content", (_label, value, status) => {
    expect(() => assertResearchAnswer(value)).toThrow(expect.objectContaining<Partial<ResearchSessionError>>({ status }))
  })

  it("accepts the exact message limit and normalizes surrounding whitespace", () => {
    const answer = "x".repeat(MAX_RESEARCH_MESSAGE_CHARS)
    expect(assertResearchAnswer(` ${answer} `)).toBe(answer)
  })

  it("accepts the exact interviewer reply limit and rejects one character over", () => {
    expect(assertResearchInterviewerReply("x".repeat(MAX_RESEARCH_INTERVIEWER_CHARS), 0))
      .toHaveLength(MAX_RESEARCH_INTERVIEWER_CHARS)
    expect(() => assertResearchInterviewerReply("x".repeat(MAX_RESEARCH_INTERVIEWER_CHARS + 1), 0))
      .toThrow(expect.objectContaining<Partial<ResearchSessionError>>({ status: 502 }))
  })

  it("rejects an interviewer reply that would exceed the aggregate canonical transcript limit", () => {
    expect(() => assertResearchInterviewerReply("xx", MAX_RESEARCH_TRANSCRIPT_CHARS - 1))
      .toThrow(expect.objectContaining<Partial<ResearchSessionError>>({ status: 502 }))
  })

  it("derives elapsed time from the persisted start time, never the browser", () => {
    const startedAt = new Date("2026-08-30T12:00:00.000Z")
    const now = new Date(startedAt.getTime() + 90_500)
    expect(getServerElapsedSeconds(startedAt, now)).toBe(91)
  })

  it("treats the exact maximum duration as expired", () => {
    const startedAt = new Date("2026-08-30T12:00:00.000Z")
    expect(getServerElapsedSeconds(startedAt, new Date(startedAt.getTime() + MAX_RESEARCH_SESSION_MS))).toBe(
      Math.round(MAX_RESEARCH_SESSION_MS / 1000),
    )
  })

  it("hashes resume secrets and never returns the raw secret as its hash", () => {
    const hash = hashResearchResumeToken("participant-session-secret")
    expect(hash).toHaveLength(64)
    expect(hash).not.toBe("participant-session-secret")
  })
})

describe("canonical research persistence", () => {
  it("atomically creates a session with persisted opening turn and hashed resume secret", async () => {
    const fixture = context()

    const result = await startOrResumeResearchSession(fixture.value)

    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function))
    expect(fixture.prisma.researchStudy.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "study-1", status: "ACTIVE" },
    }))
    expect(fixture.prisma.researchParticipantToken.findFirst).toHaveBeenCalledWith({
      where: { id: "participant-token-1", studyId: "study-1", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    })
    expect(fixture.prisma.researchSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.sessionId,
        participantTokenId: "participant-token-1",
        resumeTokenHash: hashResearchResumeToken(result.resumeToken),
        nextSequence: 1,
      }),
    })
    expect(fixture.prisma.researchTurn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: result.sessionId, role: "INTERVIEWER", sequence: 0 }),
    })
    expect(JSON.stringify(fixture.prisma.researchSession.create.mock.calls[0][0].data))
      .not.toContain(result.resumeToken)
  })

  it.each(["rotation", "revocation"])("rejects start when token %s wins the study-row race", async () => {
    const fixture = context()
    let transactionCall = 0
    fixture.prisma.$transaction.mockImplementation(async (operation: (tx: typeof fixture.prisma) => Promise<unknown>) => {
      transactionCall += 1
      if (transactionCall === 2) throw Object.assign(new Error("Concurrent token lifecycle"), { code: "P2034" })
      return operation(fixture.prisma)
    })
    fixture.prisma.researchParticipantToken.findFirst.mockResolvedValue(null)

    await expect(startOrResumeResearchSession(fixture.value)).rejects.toThrow(expect.objectContaining({ status: 404 }))
    expect(fixture.prisma.researchSession.create).not.toHaveBeenCalled()
    expect(transactionCall).toBe(3)
  })

  it("refreshes the token-expiry timestamp after a study-lock retry", async () => {
    vi.useFakeTimers()
    try {
      const firstAttempt = new Date("2026-09-04T12:00:00.000Z")
      const retryAttempt = new Date("2026-09-04T12:01:00.000Z")
      vi.setSystemTime(firstAttempt)
      const fixture = context()
      let transactionCall = 0
      fixture.prisma.$transaction.mockImplementation(async (operation: (tx: typeof fixture.prisma) => Promise<unknown>) => {
        transactionCall += 1
        if (transactionCall === 2) {
          vi.setSystemTime(retryAttempt)
          throw Object.assign(new Error("Concurrent study change"), { code: "P2034" })
        }
        return operation(fixture.prisma)
      })

      await startOrResumeResearchSession(fixture.value)

      expect(fixture.prisma.researchParticipantToken.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ expiresAt: { gt: retryAttempt } }),
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("creates a guided voice session over the same canonical domain", async () => {
    const fixture = context()
    const guidedStudy = (fixture.value as unknown as { study: { studyType: string; appUrl: string | null } }).study
    guidedStudy.studyType = "USABILITY_TEST"
    guidedStudy.appUrl = "https://example.com"
    fixture.prisma.researchStudy.findUnique.mockResolvedValue((fixture.value as unknown as { study: unknown }).study)

    const result = await startOrResumeResearchSession(fixture.value, undefined, "VOICE")

    expect(fixture.prisma.researchSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: result.sessionId, modality: "VOICE" }),
    })
    expect(fixture.prisma.researchTurn.create).not.toHaveBeenCalled()
    expect(result.turns).toEqual([])
  })

  it("creates a customer-discovery voice session when its rollout gate is enabled", async () => {
    const fixture = context()
    const result = await startOrResumeResearchSession(fixture.value, undefined, "VOICE")
    expect(fixture.prisma.researchSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: result.sessionId, modality: "VOICE" }),
    })
    expect(fixture.prisma.researchTurn.create).not.toHaveBeenCalled()
  })

  it("rejects a new customer-discovery voice session when its production rollout gate is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "")
    try {
      const fixture = context()
      await expect(startOrResumeResearchSession(fixture.value, undefined, "VOICE"))
        .rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchSessionError>)
      expect(fixture.prisma.researchSession.create).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("accepts the final start in a token window and rejects the next one", async () => {
    const accepted = context()
    accepted.prisma.researchParticipantToken.findUnique.mockResolvedValue({
      startWindowAt: new Date(),
      startCount: MAX_RESEARCH_STARTS_PER_MINUTE - 1,
      responseWindowAt: null,
      responseCount: null,
      agentWindowAt: null,
      agentCallCount: null,
    })
    await expect(startOrResumeResearchSession(accepted.value)).resolves.toMatchObject({ status: "IN_PROGRESS" })

    const rejected = context()
    rejected.prisma.researchParticipantToken.findUnique.mockResolvedValue({
      startWindowAt: new Date(),
      startCount: MAX_RESEARCH_STARTS_PER_MINUTE,
      responseWindowAt: null,
      responseCount: null,
      agentWindowAt: null,
      agentCallCount: null,
    })
    await expect(startOrResumeResearchSession(rejected.value)).rejects.toMatchObject({ status: 429 })
    expect(rejected.prisma.researchSession.create).not.toHaveBeenCalled()
  })

  it("resets an expired start window and retries a DSQL quota conflict", async () => {
    const fixture = context()
    fixture.prisma.researchParticipantToken.findUnique.mockResolvedValue({
      startWindowAt: new Date(Date.now() - 60_001),
      startCount: MAX_RESEARCH_STARTS_PER_MINUTE,
      responseWindowAt: null,
      responseCount: null,
      agentWindowAt: null,
      agentCallCount: null,
    })
    fixture.prisma.researchParticipantToken.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })

    await expect(startOrResumeResearchSession(fixture.value)).resolves.toMatchObject({ status: "IN_PROGRESS" })
    expect(fixture.prisma.researchParticipantToken.findUnique).toHaveBeenCalledTimes(2)
    expect(fixture.prisma.researchParticipantToken.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ startCount: 1, startWindowAt: expect.any(Date) }),
    }))
  })

  it("requires the session-specific resume secret when loading canonical turns", async () => {
    const fixture = context()
    fixture.prisma.researchSession.findFirst.mockResolvedValue(null)

    await expect(startOrResumeResearchSession(fixture.value, {
      sessionId: "session-1",
      resumeToken: "wrong-secret",
    })).rejects.toMatchObject({ status: 404 })
    expect(fixture.prisma.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        studyId: "study-1",
        participantTokenId: "participant-token-1",
        resumeTokenHash: hashResearchResumeToken("wrong-secret"),
      }),
    }))
  })

  it("returns only terminal status when resuming a completed interview", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1",
      status: "COMPLETED",
      startedAt: now,
      createdAt: now,
      turns: [{ id: "private-answer", role: "PARTICIPANT", content: "Prior participant answer", sequence: 1 }],
    })

    await expect(startOrResumeResearchSession(fixture.value, {
      sessionId: "session-1",
      resumeToken: "resume-secret",
    })).resolves.toMatchObject({ status: "COMPLETED", turns: [] })
  })

  it("persists the participant before the agent and builds the prompt only from canonical DB turns", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1",
      studyId: "study-1",
      participantTokenId: "participant-token-1",
      resumeTokenHash: hashResearchResumeToken("resume-secret"),
      status: "IN_PROGRESS",
      startedAt: new Date(now.getTime() - 60_000),
      createdAt: now,
      activeRequestId: null,
      activeRequestExpiresAt: null,
      turns: [{ id: "turn-0", role: "INTERVIEWER", content: "Canonical opening", sequence: 0 }],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchRequest.create.mockResolvedValue({
      id: "request-1",
      sessionId: "session-1",
      idempotencyKey: "clientturnid0001",
      participantTurnId: null,
      interviewerTurnId: null,
      status: "PROCESSING",
      createdAt: now,
      updatedAt: now,
    })
    fixture.prisma.researchSession.findUnique
      .mockResolvedValueOnce({ status: "IN_PROGRESS", activeRequestId: null, activeRequestExpiresAt: null })
      .mockResolvedValueOnce({ nextSequence: 1 })
      .mockResolvedValueOnce({ nextSequence: 2 })
    fixture.prisma.researchTurn.findMany.mockResolvedValue([
      { id: "turn-0", role: "INTERVIEWER", content: "Canonical opening", sequence: 0 },
      { id: "turn-1", role: "PARTICIPANT", content: "Canonical answer", sequence: 1 },
    ])
    const runAgent = vi.fn().mockResolvedValue("Canonical follow-up")

    const result = await respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Canonical answer",
      baseUrl: "https://compass.test",
      runAgent,
    })

    expect(result.message).toBe("Canonical follow-up")
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Participant: Canonical answer"),
    }))
    expect(runAgent.mock.invocationCallOrder[0]).toBeGreaterThan(
      fixture.prisma.researchTurn.create.mock.invocationCallOrder[0],
    )
    expect(runAgent.mock.calls[0][0].prompt).not.toContain("forged interviewer")
    expect(fixture.prisma.researchRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED", interviewerTurnId: expect.any(String) }),
    }))
    expect(fixture.prisma.$transaction.mock.calls.filter((call: unknown[]) => typeof call[0] === "function"))
      .toHaveLength(3)
    const leaseUpdate = fixture.prisma.researchSession.updateMany.mock.calls.find(
      ([input]: [{ data?: { activeRequestId?: string } }]) => input.data?.activeRequestId === "request-1",
    )?.[0]
    expect(leaseUpdate.data.activeRequestExpiresAt.getTime() - now.getTime())
      .toBeGreaterThanOrEqual(RESEARCH_REQUEST_LEASE_MS)
  })

  it("atomically links authorized READY attachments to the answer and sends private bytes to the tool-free model", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", studyId: "study-1", participantTokenId: "participant-token-1",
      resumeTokenHash: hashResearchResumeToken("resume-secret"), status: "IN_PROGRESS",
      startedAt: now, createdAt: now, activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchRequest.create.mockResolvedValue({ id: "request-1", sessionId: "session-1", status: "PROCESSING", participantTurnId: null, updatedAt: now })
    fixture.prisma.researchSession.findUnique
      .mockResolvedValueOnce({ status: "IN_PROGRESS", activeRequestId: null, activeRequestExpiresAt: null, nextSequence: 0, updatedAt: now })
      .mockResolvedValueOnce({ nextSequence: 1 })
    fixture.prisma.researchTurn.findMany.mockResolvedValue([{ id: "participant-turn", role: "PARTICIPANT", content: "This screen confused me.", sequence: 0 }])
    const attachmentId = "00000000-0000-4000-8000-000000000001"
    const attachment = { id: attachmentId, status: "READY", turnId: null, workspaceId: "workspace-1", studyId: "study-1", sessionId: "session-1", blobPathname: "private/path", originalName: "screen.png", mimeType: "image/png", sizeBytes: 3 }
    fixture.prisma.researchAttachment.findMany.mockResolvedValue([attachment])
    const loadAttachmentBytes = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const runAgent = vi.fn().mockResolvedValue("What did you expect to happen?")

    await respondToResearchSession({
      context: fixture.value, sessionId: "session-1", resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001", answer: "This screen confused me.", baseUrl: "https://compass.test",
      attachmentIds: [attachmentId], loadAttachmentBytes, runAgent,
    })

    expect(fixture.prisma.researchAttachment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [attachmentId] }, sessionId: "session-1", status: "READY", turnId: null },
      data: { turnId: expect.any(String) },
    })
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ mimeType: "image/png", originalName: "screen.png", bytes: expect.any(Uint8Array) }] }))
    expect(runAgent.mock.calls[0][0]).not.toHaveProperty("blobPathname")
  })

  it("replays a completed idempotent request without invoking the agent", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null,
      activeRequestExpiresAt: null,
      turns: Array.from({ length: MAX_RESEARCH_TURNS }, (_, sequence) => ({
        id: `canonical-${sequence}`, role: "PARTICIPANT", content: "x", sequence,
      })),
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue({
      id: "request-1", status: "COMPLETED", participantTurnId: "turn-1", interviewerTurnId: "turn-2",
    })
    fixture.prisma.researchTurn.findUnique
      .mockResolvedValueOnce({ id: "turn-1", role: "PARTICIPANT", content: "Same answer", sequence: 1 })
      .mockResolvedValueOnce({ id: "turn-2", role: "INTERVIEWER", content: "Stored reply", sequence: 2 })
    const runAgent = vi.fn()

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Same answer",
      baseUrl: "https://compass.test",
      runAgent,
    })).resolves.toMatchObject({ message: "Stored reply", replayed: true })
    expect(runAgent).not.toHaveBeenCalled()
  })

  it("rejects reuse of a completed idempotency key for different participant content", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue({
      id: "request-1", status: "COMPLETED", participantTurnId: "turn-1", interviewerTurnId: "turn-2",
    })
    fixture.prisma.researchTurn.findUnique.mockResolvedValue({
      id: "turn-1", role: "PARTICIPANT", content: "Original answer", sequence: 1,
    })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Different answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
  })

  it("rejects reuse of a completed idempotency key with different attachments", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue({
      id: "request-1", status: "COMPLETED", participantTurnId: "turn-1", interviewerTurnId: "turn-2",
    })
    fixture.prisma.researchTurn.findUnique.mockResolvedValue({
      id: "turn-1", role: "PARTICIPANT", content: "Same answer", sequence: 1,
    })
    fixture.prisma.researchAttachment.findMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001" }])

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Same answer",
      attachmentIds: ["00000000-0000-4000-8000-000000000002"],
      loadAttachmentBytes: vi.fn(),
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
  })

  it("payload-checks the completed winner after a concurrent request-create conflict", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "request-1", status: "COMPLETED", participantTurnId: "turn-1", interviewerTurnId: "turn-2",
      })
    fixture.prisma.researchRequest.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))
    fixture.prisma.researchTurn.findUnique.mockResolvedValue({
      id: "turn-1", role: "PARTICIPANT", content: "Winner answer", sequence: 1,
    })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Losing different answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
  })

  it("keeps an oversized model reply retryable without persisting an interviewer turn", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null,
      turns: [{ id: "turn-0", role: "INTERVIEWER", content: "Opening", sequence: 0 }],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchRequest.create.mockResolvedValue({
      id: "request-1", sessionId: "session-1", status: "PROCESSING",
      participantTurnId: null, interviewerTurnId: null, createdAt: now, updatedAt: now,
    })
    fixture.prisma.researchSession.findUnique
      .mockResolvedValueOnce({ status: "IN_PROGRESS", activeRequestId: null, activeRequestExpiresAt: null })
      .mockResolvedValue({ nextSequence: 1 })
    fixture.prisma.researchTurn.findMany.mockResolvedValue([
      { id: "turn-0", role: "INTERVIEWER", content: "Opening", sequence: 0 },
      { id: "turn-1", role: "PARTICIPANT", content: "Answer", sequence: 1 },
    ])

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn().mockResolvedValue("x".repeat(MAX_RESEARCH_INTERVIEWER_CHARS + 1)),
    })).rejects.toMatchObject({ status: 502 })
    expect(fixture.prisma.researchTurn.create).toHaveBeenCalledTimes(1)
    expect(fixture.prisma.researchRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "request-1", status: "PROCESSING" }),
      data: expect.objectContaining({ status: "FAILED" }),
    }))
  })

  it("marks a request failed when it loses the per-session lease so retry can recover", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: "other-request", activeRequestExpiresAt: new Date(now.getTime() + 60_000), turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchRequest.create.mockResolvedValue({
      id: "request-1", status: "PROCESSING", participantTurnId: null,
      interviewerTurnId: null, createdAt: now, updatedAt: now,
    })
    fixture.prisma.researchSession.findUnique.mockResolvedValue({
      status: "IN_PROGRESS",
      activeRequestId: "other-request",
      activeRequestExpiresAt: new Date(now.getTime() + 60_000),
    })
    fixture.prisma.researchSession.updateMany.mockResolvedValue({ count: 0 })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
    expect(fixture.prisma.researchRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "request-1" }),
      data: expect.objectContaining({ status: "FAILED" }),
    }))
  })

  it("rejects the first request beyond the per-session minute quota before a paid call", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchRequest.count.mockResolvedValue(MAX_RESEARCH_RESPONSES_PER_MINUTE)
    const runAgent = vi.fn()

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent,
    })).rejects.toMatchObject({ status: 429 })
    expect(runAgent).not.toHaveBeenCalled()
  })

  it("rejects the first request beyond the aggregate participant-link quota", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchParticipantToken.findUnique.mockResolvedValue({
      startWindowAt: null,
      startCount: null,
      responseWindowAt: now,
      responseCount: MAX_RESEARCH_TOKEN_RESPONSES_PER_MINUTE,
      agentWindowAt: now,
      agentCallCount: 0,
    })
    const runAgent = vi.fn()

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent,
    })).rejects.toMatchObject({ status: 429 })
    expect(fixture.prisma.researchRequest.create).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it("rejects the first paid call beyond the participant-link daily ceiling", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchParticipantToken.findUnique.mockResolvedValue({
      startWindowAt: null,
      startCount: null,
      responseWindowAt: now,
      responseCount: 0,
      agentWindowAt: now,
      agentCallCount: MAX_RESEARCH_AGENT_CALLS_PER_DAY,
    })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 429 })
    expect(fixture.prisma.researchRequest.create).not.toHaveBeenCalled()
  })

  it("does not reclaim a processing request one tick before the stale boundary", async () => {
    vi.useFakeTimers()
    const fixture = context()
    const now = new Date("2026-08-30T12:00:00.000Z")
    vi.setSystemTime(now)
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue({
      id: "request-1", status: "PROCESSING", participantTurnId: "turn-1",
      interviewerTurnId: null, createdAt: new Date(now.getTime() - RESEARCH_REQUEST_LEASE_MS),
      updatedAt: new Date(now.getTime() - RESEARCH_REQUEST_LEASE_MS + 1),
    })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
    expect(fixture.prisma.researchRequest.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "STALE_REQUEST" }),
    }))
    vi.useRealTimers()
  })

  it("reclaims a processing request at the stale boundary and reuses its persisted participant turn", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-30T12:00:00.000Z")
    vi.setSystemTime(now)
    const fixture = context()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: "request-1", activeRequestExpiresAt: now,
      turns: [
        { id: "turn-0", role: "INTERVIEWER", content: "Opening", sequence: 0 },
        { id: "turn-1", role: "PARTICIPANT", content: "Saved answer", sequence: 1 },
      ],
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue({
      id: "request-1", sessionId: "session-1", idempotencyKey: "clientturnid0001",
      status: "PROCESSING", participantTurnId: "turn-1", interviewerTurnId: null,
      createdAt: new Date(now.getTime() - RESEARCH_REQUEST_LEASE_MS),
      updatedAt: new Date(now.getTime() - RESEARCH_REQUEST_LEASE_MS),
    })
    fixture.prisma.researchTurn.findUnique.mockResolvedValue({
      id: "turn-1", role: "PARTICIPANT", content: "Saved answer", sequence: 1,
    })
    fixture.prisma.researchTurn.findMany.mockResolvedValue([
      { id: "turn-0", role: "INTERVIEWER", content: "Opening", sequence: 0 },
      { id: "turn-1", role: "PARTICIPANT", content: "Saved answer", sequence: 1 },
    ])
    fixture.prisma.researchSession.findUnique
      .mockResolvedValueOnce({ status: "IN_PROGRESS", activeRequestId: "request-1", activeRequestExpiresAt: now })
      .mockResolvedValue({ nextSequence: 2 })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Saved answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn().mockResolvedValue("Recovered reply"),
    })).resolves.toMatchObject({ message: "Recovered reply" })
    expect(fixture.prisma.researchRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "STALE_REQUEST" }),
    }))
    expect(fixture.prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        activeRequestId: "request-1",
        activeRequestExpiresAt: now,
      }),
    }))
    expect(fixture.prisma.researchTurn.create).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it.each([
    ["turn", Array.from({ length: MAX_RESEARCH_TURNS }, (_, sequence) => ({ id: `turn-${sequence}`, role: "PARTICIPANT", content: "x", sequence }))],
    ["transcript", [{ id: "turn-0", role: "PARTICIPANT", content: "x".repeat(MAX_RESEARCH_TRANSCRIPT_CHARS), sequence: 0 }]],
  ])("rejects the exact %s ceiling before creating a request or invoking the agent", async (_limit, turns) => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns,
    })
    const runAgent = vi.fn()

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "a",
      baseUrl: "https://compass.test",
      runAgent,
    })).rejects.toMatchObject({ status: 409 })
    expect(fixture.prisma.researchRequest.create).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it("rejects a new answer when its participant and interviewer turns would exceed the ceiling", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null,
      turns: Array.from({ length: MAX_RESEARCH_TURNS - 1 }, (_, sequence) => ({
        id: `turn-${sequence}`, role: "PARTICIPANT", content: "x", sequence,
      })),
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
    expect(fixture.prisma.researchRequest.create).not.toHaveBeenCalled()
  })

  it("rechecks canonical capacity after acquiring the lease instead of trusting a stale snapshot", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null,
      turns: Array.from({ length: MAX_RESEARCH_TURNS - 3 }, (_, sequence) => ({
        id: `stale-${sequence}`, role: "PARTICIPANT", content: "x", sequence,
      })),
    })
    fixture.prisma.researchRequest.findUnique.mockResolvedValue(null)
    fixture.prisma.researchRequest.create.mockResolvedValue({
      id: "request-1", sessionId: "session-1", status: "PROCESSING",
      participantTurnId: null, interviewerTurnId: null, createdAt: now, updatedAt: now,
    })
    fixture.prisma.researchTurn.findMany.mockResolvedValue(
      Array.from({ length: MAX_RESEARCH_TURNS - 1 }, (_, sequence) => ({
        id: `fresh-${sequence}`, role: "PARTICIPANT", content: "x", sequence,
      })),
    )

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
    expect(fixture.prisma.researchTurn.create).not.toHaveBeenCalled()
  })

  it("abandons a session at the exact server-side duration boundary", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-30T12:00:00.000Z")
    vi.setSystemTime(now)
    const fixture = context()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS",
      startedAt: new Date(now.getTime() - MAX_RESEARCH_SESSION_MS), createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null, turns: [],
    })

    await expect(respondToResearchSession({
      context: fixture.value,
      sessionId: "session-1",
      resumeToken: "resume-secret",
      idempotencyKey: "clientturnid0001",
      answer: "Answer",
      baseUrl: "https://compass.test",
      runAgent: vi.fn(),
    })).rejects.toMatchObject({ status: 409 })
    expect(fixture.prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ABANDONED" }),
    }))
    vi.useRealTimers()
  })

  it("completes from canonical history without deleting or recreating turns and clears a stale lease", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "IN_PROGRESS", startedAt: now, createdAt: now,
      activeRequestId: "stale-request", activeRequestExpiresAt: new Date(now.getTime() - 1),
      turns: [{ id: "turn-0", role: "INTERVIEWER", content: "Opening", sequence: 0 }],
    })

    await expect(completeResearchSession(fixture.value, "session-1", "resume-secret"))
      .resolves.toMatchObject({ ok: true, status: "COMPLETED" })
    expect(fixture.prisma.researchSession.updateMany).toHaveBeenCalledTimes(2)
    expect(fixture.prisma.researchTurn.create).not.toHaveBeenCalled()
    expect(fixture.prisma.researchTurn).not.toHaveProperty("deleteMany")
  })

  it("completes idempotently without returning or rewriting the transcript", async () => {
    const fixture = context()
    const now = new Date()
    fixture.prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", status: "COMPLETED", startedAt: now, createdAt: now,
      activeRequestId: null, activeRequestExpiresAt: null,
      turns: [{ id: "turn-1", role: "PARTICIPANT", content: "Private", sequence: 1 }],
    })

    const result = await completeResearchSession(fixture.value, "session-1", "resume-secret")

    expect(result).toEqual({ ok: true, status: "COMPLETED" })
    expect(result).not.toHaveProperty("turns")
    expect(fixture.prisma.researchSession.updateMany).not.toHaveBeenCalled()
    expect(fixture.prisma.researchTurn.create).not.toHaveBeenCalled()
  })

  it("reconciles inactive sessions to an authoritative abandoned state for researcher views", async () => {
    const fixture = context()
    const now = new Date("2026-08-30T12:00:00.000Z")

    await reconcileAbandonedResearchSessions(fixture.prisma as never, "study-1", now)

    expect(fixture.prisma.researchSession.updateMany).toHaveBeenCalledWith({
      where: {
        studyId: "study-1",
        status: "IN_PROGRESS",
        OR: [
          { lastActiveAt: { lte: new Date(now.getTime() - MAX_RESEARCH_SESSION_MS) } },
          { lastActiveAt: null, startedAt: { lte: new Date(now.getTime() - MAX_RESEARCH_SESSION_MS) } },
        ],
      },
      data: expect.objectContaining({
        status: "ABANDONED",
        endedReason: "INACTIVITY_TIMEOUT",
        activeRequestId: null,
      }),
    })
  })
})
