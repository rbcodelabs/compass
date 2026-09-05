import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MAX_RESEARCH_VOICE_ATTEMPTS_PER_DAY,
  MAX_RESEARCH_VOICE_ATTEMPTS_PER_MINUTE,
  MAX_RESEARCH_VOICE_ATTEMPTS_PER_SESSION,
  ResearchVoiceControlPlaneError,
  allocateResearchVoiceCall,
  appendCanonicalVoiceBatch,
  createVoiceWorkerCredential,
  hashVoiceWorkerToken,
  planCanonicalVoiceBatch,
  reconcilePersistedResearchVoiceCall,
  reconcileResearchVoiceCall,
  researchVoiceLeaseExpiresAt,
  transitionResearchVoiceCall,
  voiceAnswerRetentionPatch,
  voiceCallTransitionPatch,
  voiceWorkerTokenIsBound,
} from "@/lib/research-voice-control-plane"

function allocationFixture() {
  const prisma = {
    researchVoiceCall: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data })),
    },
    researchSession: {
      findFirst: vi.fn().mockResolvedValue({
        id: "session-1",
        participantTokenId: "token-1",
        status: "IN_PROGRESS",
        modality: "VOICE",
        voiceLeaseId: null,
        voiceLeaseExpiresAt: null,
        voiceAttemptCount: 0,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    researchParticipantToken: {
      findFirst: vi.fn().mockResolvedValue({
        id: "token-1",
        voiceWindowAt: null,
        voiceCount: 0,
        voiceDayAt: null,
        voiceDayCount: 0,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  }
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma))
  return prisma
}

describe("authoritative research voice control plane", () => {
  beforeEach(() => vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1"))
  afterEach(() => vi.unstubAllEnvs())

  it("permits only forward call transitions and clears the SDP on media ready", () => {
    expect(voiceCallTransitionPatch("PROVISIONING", "PROVIDER_CREATED", new Date(0))).toEqual({
      status: "PROVIDER_CREATED",
      statusChangedAt: new Date(0),
      updatedAt: new Date(0),
    })
    expect(voiceCallTransitionPatch("READY", "ACTIVE", new Date(1))).toEqual({
      status: "ACTIVE",
      answerSdp: null,
      connectedAt: new Date(1),
      statusChangedAt: new Date(1),
      updatedAt: new Date(1),
    })
    expect(() => voiceCallTransitionPatch("COMPLETED", "ACTIVE", new Date())).toThrow(ResearchVoiceControlPlaneError)
    expect(() => voiceCallTransitionPatch("ACTIVE", "READY", new Date())).toThrow(ResearchVoiceControlPlaneError)
    expect(() => voiceCallTransitionPatch("DISCONNECTING", "COMPLETED", new Date(), { orderedBufferDrained: false }))
      .toThrowError(expect.objectContaining({ code: "TRANSCRIPT_NOT_DRAINED" }))
    expect(voiceCallTransitionPatch("DISCONNECTING", "COMPLETED", new Date(2), { orderedBufferDrained: true }))
      .toMatchObject({ status: "COMPLETED", transcriptIntegrity: "COMPLETE", statusChangedAt: new Date(2) })
    expect(voiceCallTransitionPatch("ACTIVE", "FAILED", new Date(3)))
      .toMatchObject({ status: "FAILED", transcriptIntegrity: "DEGRADED", statusChangedAt: new Date(3) })
    expect(voiceAnswerRetentionPatch({
      status: "PROVIDER_CREATED",
      answerSdp: "short-lived-answer",
      createdAt: new Date(0),
    }, new Date(60_001))).toEqual({ answerSdp: null, updatedAt: new Date(60_001) })
  })

  it("creates a 256-bit callback token and binds only its hash to its call", () => {
    const credential = createVoiceWorkerCredential()
    expect(Buffer.from(credential.rawToken, "base64url")).toHaveLength(32)
    expect(credential.tokenHash).toBe(hashVoiceWorkerToken(credential.rawToken))
    expect(credential.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(voiceWorkerTokenIsBound({
      rawToken: credential.rawToken,
      expectedTokenHash: credential.tokenHash,
      presentedCallId: "call-1",
      expectedCallId: "call-1",
      callStatus: "READY",
      expiresAt: new Date(2),
      now: new Date(1),
    })).toBe(true)
    expect(voiceWorkerTokenIsBound({
      rawToken: credential.rawToken,
      expectedTokenHash: credential.tokenHash,
      presentedCallId: "call-2",
      expectedCallId: "call-1",
      callStatus: "READY",
      expiresAt: new Date(2),
      now: new Date(1),
    })).toBe(false)
    expect(voiceWorkerTokenIsBound({
      rawToken: credential.rawToken,
      expectedTokenHash: credential.tokenHash,
      presentedCallId: "call-1",
      expectedCallId: "call-1",
      callStatus: "READY",
      expiresAt: new Date(1),
      now: new Date(1),
    })).toBe(false)
    expect(voiceWorkerTokenIsBound({
      rawToken: credential.rawToken, expectedTokenHash: credential.tokenHash,
      presentedCallId: "call-1", expectedCallId: "call-1", callStatus: "COMPLETED",
      expiresAt: new Date(2), now: new Date(1),
    })).toBe(false)
  })

  it("replays the same offer without consuming quota and rejects key reuse with another offer", async () => {
    const prisma = allocationFixture()
    prisma.researchVoiceCall.findUnique.mockResolvedValue({
      id: "call-1", sessionId: "session-1", participantTokenId: "token-1",
      offerSha256: hashVoiceWorkerToken("offer-a"), status: "READY",
      answerSdp: "retained-answer", leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
      voiceLeaseId: "call-1", voiceLeaseExpiresAt: new Date(Date.now() + 60_000), voiceAttemptCount: 1,
    })

    await expect(allocateResearchVoiceCall({
      prisma: prisma as never,
      sessionId: "session-1",
      participantTokenId: "token-1",
      idempotencyKey: "attempt-1",
      offerSdp: "offer-a",
      targetMinutes: 1,
    })).resolves.toMatchObject({ replayed: true, call: { id: "call-1" }, workerToken: null })
    expect(prisma.researchParticipantToken.updateMany).not.toHaveBeenCalled()
    expect(prisma.researchSession.updateMany).not.toHaveBeenCalled()

    prisma.researchParticipantToken.findFirst.mockResolvedValueOnce(null)
    await expect(allocateResearchVoiceCall({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
      idempotencyKey: "attempt-1", offerSdp: "offer-a", targetMinutes: 1,
    })).rejects.toMatchObject({ code: "TOKEN_NOT_FOUND" })

    prisma.researchSession.findFirst.mockResolvedValueOnce({
      id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
      voiceLeaseId: "different-call", voiceLeaseExpiresAt: new Date(Date.now() + 60_000), voiceAttemptCount: 1,
    })
    await expect(allocateResearchVoiceCall({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
      idempotencyKey: "attempt-1", offerSdp: "offer-b", targetMinutes: 1,
    })).rejects.toMatchObject({ code: "REPLAY_UNAVAILABLE" })

    prisma.researchParticipantToken.findFirst.mockResolvedValueOnce(null)
    await expect(allocateResearchVoiceCall({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
      idempotencyKey: "attempt-1", offerSdp: "offer-b", targetMinutes: 1,
    })).rejects.toMatchObject({ code: "TOKEN_NOT_FOUND" })

    await expect(allocateResearchVoiceCall({
      prisma: prisma as never,
      sessionId: "session-1",
      participantTokenId: "token-1",
      idempotencyKey: "attempt-1",
      offerSdp: "offer-b",
      targetMinutes: 1,
    })).rejects.toMatchObject({ status: 409 } satisfies Partial<ResearchVoiceControlPlaneError>)
  })

  it("requires a new key when an exact replay can no longer return usable control state", async () => {
    for (const prior of [
      { status: "COMPLETED", answerSdp: "answer", leaseExpiresAt: new Date(Date.now() + 60_000) },
      { status: "READY", answerSdp: null, leaseExpiresAt: new Date(Date.now() + 60_000) },
      { status: "READY", answerSdp: "answer", leaseExpiresAt: new Date(Date.now() - 1) },
    ]) {
      const prisma = allocationFixture()
      prisma.researchVoiceCall.findUnique.mockResolvedValue({
        id: "call-1", sessionId: "session-1", participantTokenId: "token-1",
        offerSha256: hashVoiceWorkerToken("offer-a"), ...prior,
      })
      prisma.researchSession.findFirst.mockResolvedValue({
        id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
        voiceLeaseId: "call-1", voiceLeaseExpiresAt: prior.leaseExpiresAt, voiceAttemptCount: 1,
      })
      await expect(allocateResearchVoiceCall({
        prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
        idempotencyKey: "attempt-1", offerSdp: "offer-a", targetMinutes: 1,
      })).rejects.toMatchObject({ status: 409, code: "REPLAY_UNAVAILABLE" } satisfies Partial<ResearchVoiceControlPlaneError>)
      expect(prisma.researchSession.updateMany).not.toHaveBeenCalled()
    }
  })

  it("accepts the last token and session attempt slots and rejects the first over each limit", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z")
    const prisma = allocationFixture()
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
      voiceLeaseId: null, voiceLeaseExpiresAt: null, voiceAttemptCount: MAX_RESEARCH_VOICE_ATTEMPTS_PER_SESSION - 1,
    })
    prisma.researchParticipantToken.findFirst.mockResolvedValue({
      id: "token-1", voiceWindowAt: now, voiceCount: MAX_RESEARCH_VOICE_ATTEMPTS_PER_MINUTE - 1,
      voiceDayAt: now, voiceDayCount: MAX_RESEARCH_VOICE_ATTEMPTS_PER_DAY - 1,
    })
    await expect(allocateResearchVoiceCall({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
      idempotencyKey: "last-slot", offerSdp: "offer", targetMinutes: 1, now,
    })).resolves.toMatchObject({ replayed: false, workerToken: expect.any(String) })
    expect(prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ voiceAttemptCount: { increment: 1 } }),
    }))

    for (const over of [
      { voiceCount: MAX_RESEARCH_VOICE_ATTEMPTS_PER_MINUTE, voiceDayCount: 0, voiceAttemptCount: 0 },
      { voiceCount: 0, voiceDayCount: MAX_RESEARCH_VOICE_ATTEMPTS_PER_DAY, voiceAttemptCount: 0 },
      { voiceCount: 0, voiceDayCount: 0, voiceAttemptCount: MAX_RESEARCH_VOICE_ATTEMPTS_PER_SESSION },
    ]) {
      const rejected = allocationFixture()
      rejected.researchSession.findFirst.mockResolvedValue({
        id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
        voiceLeaseId: null, voiceLeaseExpiresAt: null, voiceAttemptCount: over.voiceAttemptCount,
      })
      rejected.researchParticipantToken.findFirst.mockResolvedValue({
        id: "token-1", voiceWindowAt: now, voiceCount: over.voiceCount,
        voiceDayAt: now, voiceDayCount: over.voiceDayCount,
      })
      await expect(allocateResearchVoiceCall({
        prisma: rejected as never, sessionId: "session-1", participantTokenId: "token-1",
        idempotencyKey: `over-${over.voiceCount}-${over.voiceDayCount}-${over.voiceAttemptCount}`,
        offerSdp: "offer", targetMinutes: 1, now,
      })).rejects.toMatchObject({ status: 429 } satisfies Partial<ResearchVoiceControlPlaneError>)
      expect(rejected.researchVoiceCall.create).not.toHaveBeenCalled()
    }
  })

  it("allows only one concurrent live-call lease CAS", async () => {
    const prisma = allocationFixture()
    let available = true
    prisma.researchSession.updateMany.mockImplementation(async () => {
      if (!available) return { count: 0 }
      available = false
      return { count: 1 }
    })
    const results = await Promise.allSettled(["a", "b"].map((suffix) => allocateResearchVoiceCall({
      prisma: prisma as never,
      sessionId: "session-1",
      participantTokenId: "token-1",
      idempotencyKey: `attempt-${suffix}`,
      offerSdp: `offer-${suffix}`,
      targetMinutes: 1,
    })))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
    ])
  })

  it("requires reconciliation for every persisted lease pointer and bounds new leases", async () => {
    for (const voiceLeaseExpiresAt of [null, new Date(Date.now() - 1), new Date(Date.now() + 60_000)]) {
      const prisma = allocationFixture()
      prisma.researchSession.findFirst.mockResolvedValue({
        id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
        voiceLeaseId: "stale-call", voiceLeaseExpiresAt, voiceAttemptCount: 0,
      })
      await expect(allocateResearchVoiceCall({
        prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
        idempotencyKey: "new-key", offerSdp: "offer", targetMinutes: 1,
      })).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" })
    }
    const prisma = allocationFixture()
    await expect(allocateResearchVoiceCall({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
      idempotencyKey: "too-long", offerSdp: "offer", targetMinutes: 31,
    })).rejects.toMatchObject({ code: "INVALID_LEASE" })
    const now = new Date("2026-09-05T12:00:00.000Z")
    expect(researchVoiceLeaseExpiresAt(now, 30)).toEqual(new Date(now.getTime() + 35 * 60_000))
  })

  it("sets nullable migrated counters to one instead of incrementing NULL", async () => {
    const prisma = allocationFixture()
    prisma.researchSession.findFirst.mockResolvedValue({
      id: "session-1", participantTokenId: "token-1", status: "IN_PROGRESS", modality: "VOICE",
      voiceLeaseId: null, voiceLeaseExpiresAt: null, voiceAttemptCount: null,
    })
    prisma.researchParticipantToken.findFirst.mockResolvedValue({
      id: "token-1", voiceWindowAt: new Date(), voiceCount: null, voiceDayAt: new Date(), voiceDayCount: null,
    })
    await allocateResearchVoiceCall({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1",
      idempotencyKey: "nullable-counters", offerSdp: "offer", targetMinutes: 1,
    })
    expect(prisma.researchParticipantToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ voiceCount: 1, voiceDayCount: 1 }),
    }))
    expect(prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ voiceAttemptCount: 1 }),
    }))
  })

  it("emits only contiguous terminal canonical turns and omits failed interviewer provenance", () => {
    const plan = planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1",
      expectedOrdinal: 3,
      previousProviderItemId: "item-2",
      nextSequence: 10,
      turnCount: 48,
      transcriptChars: 59_990,
      events: [
        { voiceCallId: "call-1", sessionId: "session-1", providerOrdinal: 5, providerItemId: "item-5", providerPreviousItemId: "item-4", providerStatus: "COMPLETED", role: "PARTICIPANT", content: "later" },
        { voiceCallId: "call-1", sessionId: "session-1", providerOrdinal: 4, providerItemId: "item-4", providerPreviousItemId: "item-3", providerStatus: "FAILED", role: "INTERVIEWER", content: "" },
        { voiceCallId: "call-1", sessionId: "session-1", providerOrdinal: 3, providerItemId: "item-3", providerPreviousItemId: "item-2", providerStatus: "COMPLETED", role: "PARTICIPANT", content: "12345" },
      ],
    })
    expect(plan.turns).toEqual([
      { providerOrdinal: 3, sequence: 10, role: "PARTICIPANT", content: "12345" },
      { providerOrdinal: 5, sequence: 11, role: "PARTICIPANT", content: "later" },
    ])
    expect(plan.acceptedOrdinals).toEqual([3, 4, 5])
    expect(plan.nextExpectedOrdinal).toBe(6)
    expect(plan.sessionCas).toEqual({
      expected: { nextSequence: 10, voiceTurnCount: 48, voiceTranscriptChars: 59_990 },
      update: { nextSequence: 12, voiceTurnCount: 50, voiceTranscriptChars: 60_000 },
    })
    expect(plan.callCas).toEqual({
      expected: { id: "call-1", sessionId: "session-1", nextProviderOrdinal: 3, lastProviderItemId: "item-2" },
      update: { nextProviderOrdinal: 6, lastProviderItemId: "item-5" },
    })
    expect(plan.transactionalCas).toEqual({ call: plan.callCas, session: plan.sessionCas })
  })

  it("waits on a missing ordinal and degrades on failed participant transcription", () => {
    expect(planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 1, previousProviderItemId: "item-0", nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [{ voiceCallId: "call-1", sessionId: "session-1", providerOrdinal: 2, providerItemId: "item-2", providerPreviousItemId: "item-1", providerStatus: "COMPLETED", role: "INTERVIEWER", content: "later" }],
    })).toMatchObject({ acceptedOrdinals: [], turns: [], nextExpectedOrdinal: 1, transcriptIntegrity: "PENDING" })

    expect(planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 1, previousProviderItemId: "item-0", nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [{ voiceCallId: "call-1", sessionId: "session-1", providerOrdinal: 1, providerItemId: "item-1", providerPreviousItemId: "item-0", providerStatus: "FAILED", role: "PARTICIPANT", content: "" }],
    })).toMatchObject({ transcriptIntegrity: "DEGRADED", abortReason: "PARTICIPANT_TRANSCRIPTION_FAILED" })
  })

  it("rejects the first canonical turn or character beyond the shared caps", () => {
    const event = { voiceCallId: "call-1", sessionId: "session-1", providerOrdinal: 1, providerItemId: "item-1", providerPreviousItemId: null, providerStatus: "COMPLETED", role: "PARTICIPANT" as const, content: "x" }
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", events: [event], expectedOrdinal: 1, previousProviderItemId: null, nextSequence: 50,
      turnCount: 50, transcriptChars: 1,
    })).toThrowError(expect.objectContaining({ code: "TRANSCRIPT_LIMIT" }))
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", events: [event], expectedOrdinal: 1, previousProviderItemId: null, nextSequence: 1,
      turnCount: 1, transcriptChars: 60_000,
    })).toThrowError(expect.objectContaining({ code: "TRANSCRIPT_LIMIT" }))
  })

  it("counts transcript characters consistently for emoji and rejects duplicate provider coordinates", () => {
    const base = { voiceCallId: "call-1", sessionId: "session-1", providerPreviousItemId: null, providerStatus: "COMPLETED", role: "PARTICIPANT" as const }
    const emoji = planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [{ ...base, providerOrdinal: 0, providerItemId: "emoji", content: "🙂" }],
    })
    expect(emoji.nextTranscriptChars).toBe(1)
    expect(planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [
        { ...base, providerOrdinal: 0, providerItemId: "a", content: "a" },
        { ...base, providerOrdinal: 0, providerItemId: "b", content: "b" },
      ],
    })).toMatchObject({ transcriptIntegrity: "DEGRADED", abortReason: "PROVIDER_COORDINATE_CONFLICT" })
  })

  it("rejects oversized callback batches and mismatched redundant identifiers", () => {
    const event = { voiceCallId: "other", sessionId: "session-1", providerOrdinal: 0, providerItemId: "item", providerPreviousItemId: null, providerStatus: "COMPLETED", role: "PARTICIPANT" as const, content: "x" }
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0, events: [event],
    })).toThrowError(expect.objectContaining({ code: "CALL_BINDING_MISMATCH" }))
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0, events: Array.from({ length: 11 }, (_, providerOrdinal) => ({ ...event, voiceCallId: "call-1", providerOrdinal, providerItemId: `item-${providerOrdinal}` })),
    })).toThrowError(expect.objectContaining({ code: "CALLBACK_BATCH_TOO_LARGE" }))
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [{ ...event, voiceCallId: "call-1", providerItemId: "x", content: "x".repeat(65_536) }],
    })).toThrowError(expect.objectContaining({ code: "CALLBACK_PAYLOAD_TOO_LARGE" }))
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [{ ...event, voiceCallId: "call-1", providerItemId: "x", role: "SYSTEM" as never }],
    })).toThrowError(expect.objectContaining({ code: "INVALID_CALLBACK_EVENT" }))
    expect(() => planCanonicalVoiceBatch({
      voiceCallId: "call-1", sessionId: "session-1", expectedOrdinal: 0, previousProviderItemId: null,
      nextSequence: 0, turnCount: 0, transcriptChars: 0,
      events: [{ ...event, voiceCallId: "call-1", providerItemId: "x", providerStatus: "MYSTERY" }],
    })).toThrowError(expect.objectContaining({ code: "INVALID_CALLBACK_EVENT" }))
  })

  it("commits call cursor and session counters under CAS in one transaction", async () => {
    const tx = {
      researchVoiceCall: {
        findFirst: vi.fn().mockResolvedValue({ id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 0, lastProviderItemId: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      researchSession: {
        findFirst: vi.fn().mockResolvedValue({ nextSequence: 7, voiceTurnCount: 2, voiceTranscriptChars: 10 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      researchVoiceEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      researchTurn: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    const event = {
      voiceCallId: "call-1", sessionId: "session-1", providerEventId: "event-1", providerOrdinal: 0,
      providerItemId: "item-1", providerPreviousItemId: null, providerStatus: "COMPLETED",
      role: "PARTICIPANT" as const, content: "hello",
    }
    await appendCanonicalVoiceBatch({ prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", events: [event] })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 0, lastProviderItemId: null },
      data: expect.objectContaining({ nextProviderOrdinal: 1, lastProviderItemId: "item-1" }),
    }))
    expect(tx.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "session-1", voiceLeaseId: "call-1", nextSequence: 7, voiceTurnCount: 2, voiceTranscriptChars: 10 }),
      data: expect.objectContaining({ nextSequence: 8, voiceTurnCount: 3, voiceTranscriptChars: 15 }),
    }))

    tx.researchVoiceCall.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(appendCanonicalVoiceBatch({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1",
      events: [{ ...event, providerEventId: "event-race" }],
    })).rejects.toMatchObject({ code: "CALLBACK_RACE" })

    tx.researchVoiceCall.findFirst.mockResolvedValue({
      id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 0, lastProviderItemId: null,
      workerTokenHash: hashVoiceWorkerToken("worker"), leaseExpiresAt: new Date("2026-09-05T12:00:00Z"),
    } as never)
    await expect(appendCanonicalVoiceBatch({ prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", events: [event], workerToken: "worker", now: new Date("2026-09-05T12:01:00Z") }))
      .rejects.toMatchObject({ code: "INVALID_WORKER_TOKEN" })
  })

  it("acknowledges exact callback replays and processes only an unseen contiguous suffix", async () => {
    const stored = (ordinal: number, item: string, previous: string | null, content: string) => ({
      id: `stored-${ordinal}`, voiceCallId: "call-1", sessionId: "session-1", providerEventId: `event-${ordinal}`,
      providerOrdinal: ordinal, providerItemId: item, providerPreviousItemId: previous, providerResponseId: null,
      providerStatus: "COMPLETED", role: "PARTICIPANT", content,
    })
    const event = (ordinal: number, item: string, previous: string | null, content: string) => ({
      voiceCallId: "call-1", sessionId: "session-1", providerEventId: `event-${ordinal}`,
      providerOrdinal: ordinal, providerItemId: item, providerPreviousItemId: previous, providerResponseId: null,
      providerStatus: "COMPLETED", role: "PARTICIPANT" as const, content,
    })
    const tx = {
      researchVoiceCall: {
        findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      researchSession: {
        findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      researchVoiceEvent: { findMany: vi.fn(), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      researchTurn: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }

    tx.researchVoiceCall.findFirst.mockResolvedValue({ id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 2, lastProviderItemId: "item-1" })
    tx.researchSession.findFirst.mockResolvedValue({ nextSequence: 2, voiceTurnCount: 2, voiceTranscriptChars: 6 })
    tx.researchVoiceEvent.findMany.mockResolvedValue([stored(0, "item-0", null, "one"), stored(1, "item-1", "item-0", "two")])
    await expect(appendCanonicalVoiceBatch({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1",
      events: [event(0, "item-0", null, "one"), event(1, "item-1", "item-0", "two")],
    })).resolves.toMatchObject({ replayedEventIds: ["event-0", "event-1"], acceptedOrdinals: [] })
    expect(tx.researchVoiceCall.updateMany).not.toHaveBeenCalled()
    expect(tx.researchVoiceEvent.createMany).not.toHaveBeenCalled()

    tx.researchVoiceCall.findFirst.mockResolvedValue({ id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 1, lastProviderItemId: "item-0" })
    tx.researchSession.findFirst.mockResolvedValue({ nextSequence: 1, voiceTurnCount: 1, voiceTranscriptChars: 3 })
    tx.researchVoiceEvent.findMany.mockResolvedValue([stored(0, "item-0", null, "one")])
    await expect(appendCanonicalVoiceBatch({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1",
      events: [event(0, "item-0", null, "one")],
    })).resolves.toMatchObject({ replayedEventIds: ["event-0"], acceptedOrdinals: [] })

    tx.researchVoiceCall.findFirst.mockResolvedValue({ id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 2, lastProviderItemId: "item-1" })
    tx.researchSession.findFirst.mockResolvedValue({ nextSequence: 2, voiceTurnCount: 2, voiceTranscriptChars: 6 })
    tx.researchVoiceEvent.findMany.mockResolvedValue([stored(1, "item-1", "item-0", "two")])
    await expect(appendCanonicalVoiceBatch({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1",
      events: [event(1, "item-1", "item-0", "two"), event(2, "item-2", "item-1", "three")],
    })).resolves.toMatchObject({ replayedEventIds: ["event-1"], acceptedOrdinals: [2] })
    expect(tx.researchVoiceEvent.createMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ providerEventId: "event-2", providerOrdinal: 2 })],
    }))

    tx.researchVoiceCall.updateMany.mockClear()
    tx.researchVoiceEvent.createMany.mockClear()
    tx.researchVoiceEvent.findMany.mockResolvedValue([{ ...stored(2, "item-2", "item-1", "different") }])
    await expect(appendCanonicalVoiceBatch({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1",
      events: [event(2, "item-2", "item-1", "three")],
    })).resolves.toMatchObject({ transcriptIntegrity: "DEGRADED", abortReason: "PROVIDER_COORDINATE_CONFLICT" })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ transcriptIntegrity: "DEGRADED", errorCode: "PROVIDER_COORDINATE_CONFLICT" }),
    }))
    expect(tx.researchVoiceEvent.createMany).not.toHaveBeenCalled()
  })

  it("rejects callback ingress outside active draining states or after degradation", async () => {
    for (const call of [
      { status: "READY", transcriptIntegrity: "PENDING" },
      { status: "ACTIVE", transcriptIntegrity: "DEGRADED" },
    ]) {
      const tx = {
        researchVoiceCall: { findFirst: vi.fn().mockResolvedValue({ id: "call-1", sessionId: "session-1", nextProviderOrdinal: 0, lastProviderItemId: null, ...call }) },
      }
      const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
      await expect(appendCanonicalVoiceBatch({ prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", events: [] }))
        .rejects.toMatchObject({ code: call.status === "READY" ? "CALL_NOT_EVENT_BEARING" : "TRANSCRIPT_DEGRADED" })
    }
  })

  it("persists transitions and reconciliation with fenced call and lease CAS", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z")
    const tx = {
      researchVoiceCall: {
        findFirst: vi.fn().mockResolvedValue({ id: "call-1", sessionId: "session-1", status: "DISCONNECTING", transcriptIntegrity: "PENDING", nextProviderOrdinal: 3, lastProviderItemId: "item-2", leaseExpiresAt: new Date(now.getTime() + 60_000), lastHeartbeatAt: now, statusChangedAt: now }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      researchSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    await transitionResearchVoiceCall({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", expectedStatus: "DISCONNECTING",
      expectedNextProviderOrdinal: 3, expectedLastProviderItemId: "item-2", nextStatus: "COMPLETED",
      orderedBufferDrained: true, now,
    })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "DISCONNECTING", nextProviderOrdinal: 3, lastProviderItemId: "item-2" }),
      data: expect.objectContaining({ status: "COMPLETED", transcriptIntegrity: "COMPLETE" }),
    }))
    expect(tx.researchSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1", voiceLeaseId: "call-1" },
      data: { voiceLeaseId: null, voiceLeaseExpiresAt: null, updatedAt: now },
    })

    tx.researchVoiceCall.findFirst.mockResolvedValue({ id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING", nextProviderOrdinal: 3, lastProviderItemId: "item-2", leaseExpiresAt: new Date(now.getTime() - 1), lastHeartbeatAt: now, statusChangedAt: now })
    await reconcilePersistedResearchVoiceCall({ prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", now })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "ACTIVE", nextProviderOrdinal: 3, lastProviderItemId: "item-2" }),
      data: expect.objectContaining({ status: "EXPIRED", transcriptIntegrity: "DEGRADED" }),
    }))
  })

  it("does not terminalize or release a lease after a concurrent heartbeat refresh", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z")
    const observedHeartbeat = new Date(now.getTime() - 45_000)
    const tx = {
      researchVoiceCall: {
        findFirst: vi.fn().mockResolvedValue({
          id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING",
          nextProviderOrdinal: 3, lastProviderItemId: "item-2",
          leaseExpiresAt: new Date(now.getTime() + 60_000), lastHeartbeatAt: observedHeartbeat,
          statusChangedAt: new Date(now.getTime() - 60_000),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      researchSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    await expect(reconcilePersistedResearchVoiceCall({
      prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", now,
    })).rejects.toMatchObject({ code: "RECONCILIATION_RACE" })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        lastHeartbeatAt: observedHeartbeat,
        statusChangedAt: new Date(now.getTime() - 60_000),
      }),
    }))
    expect(tx.researchSession.updateMany).not.toHaveBeenCalled()
  })

  it("reconciles stale nonterminal calls without mutating terminal calls", () => {
    const now = new Date("2026-09-05T12:00:00.000Z")
    expect(reconcileResearchVoiceCall({ status: "ACTIVE", leaseExpiresAt: new Date(now.getTime() - 1), lastHeartbeatAt: now, statusChangedAt: now }, now))
      .toMatchObject({ callPatch: { status: "EXPIRED", transcriptIntegrity: "DEGRADED" }, releaseVoiceLease: true })
    expect(reconcileResearchVoiceCall({ status: "ACTIVE", leaseExpiresAt: new Date(now.getTime() + 60_000), lastHeartbeatAt: new Date(now.getTime() - 31_000), statusChangedAt: now }, now, 30_000))
      .toMatchObject({ callPatch: { status: "UNKNOWN", transcriptIntegrity: "DEGRADED" } })
    expect(reconcileResearchVoiceCall({ status: "COMPLETED", leaseExpiresAt: now, lastHeartbeatAt: null, statusChangedAt: now }, now))
      .toEqual({ callPatch: null, releaseVoiceLease: true })
  })

  it("uses the approved 45-second heartbeat staleness boundary", () => {
    const now = new Date("2026-09-05T12:00:00.000Z")
    expect(reconcileResearchVoiceCall({
      status: "ACTIVE", leaseExpiresAt: new Date(now.getTime() + 60_000),
      lastHeartbeatAt: null, statusChangedAt: new Date(now.getTime() - 44_999),
    }, now)).toBeNull()
    expect(reconcileResearchVoiceCall({
      status: "ACTIVE", leaseExpiresAt: new Date(now.getTime() + 60_000),
      lastHeartbeatAt: null, statusChangedAt: new Date(now.getTime() - 45_000),
    }, now)).toMatchObject({ callPatch: { status: "UNKNOWN", transcriptIntegrity: "DEGRADED" } })
  })
})
