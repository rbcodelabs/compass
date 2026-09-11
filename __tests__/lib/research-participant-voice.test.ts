import { afterEach, describe, expect, it, vi } from "vitest"
import type { ResearchStudy } from "@prisma/client"
import type { AppPrismaClient } from "@/lib/db"
import { appendParticipantVoiceEvent, claimParticipantVoiceLease } from "@/lib/research-participant-voice"

function fixture() {
  const session = { id: "session", nextSequence: 0, voiceLeaseId: "lease", voiceLeaseExpiresAt: new Date(Date.now() + 60_000), voiceAttemptCount: 0, voiceTurnCount: 0, voiceTranscriptChars: 0, turns: [], updatedAt: new Date("2026-09-11T12:00:00Z") }
  const tx = {
    researchParticipantToken: { findFirst: vi.fn().mockResolvedValue({ id: "token" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    researchStudy: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    researchSession: { findFirst: vi.fn().mockResolvedValue(session), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    researchParticipantVoiceEvent: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({}) },
    researchAttachment: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    researchTurn: { create: vi.fn().mockImplementation(({ data }) => data), findUnique: vi.fn().mockResolvedValue({ id: "turn" }) },
    pMInterview: { findUnique: vi.fn().mockResolvedValue(null) },
  }
  const context = { prisma: { $transaction: (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as AppPrismaClient,
    study: { id: "study", workspaceId: "workspace", studyType: "CUSTOMER_INTERVIEW", targetMinutes: 15 } as ResearchStudy, participantToken: { id: "token" } }
  return { tx, context, session }
}
const input = { sessionId: "session", resumeToken: "resume", leaseId: "lease", clientEventId: "client-1", reportedOrdinal: 0, role: "PARTICIPANT" as const, content: "A concrete story" }
describe("participant-submitted voice persistence", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("stores browser evidence separately and atomically advances the turn", async () => {
    const { tx, context, session } = fixture()
    await appendParticipantVoiceEvent({ context, ...input })
    expect(tx.researchParticipantVoiceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ clientEventId: "client-1", reportedOrdinal: 0, claimedSpeaker: "PARTICIPANT" }) })
    expect(tx.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ voiceLeaseExpiresAt: { gt: expect.any(Date) }, updatedAt: session.updatedAt }), data: expect.objectContaining({ nextSequence: 1 }) }))
  })
  it("advances the event session fence even within the same clock millisecond", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-11T12:00:00.000Z"))
    try {
      const { tx, context } = fixture()
      await appendParticipantVoiceEvent({ context, ...input })
      expect(tx.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ updatedAt: new Date("2026-09-11T12:00:00.001Z") }) }))
    } finally { vi.useRealTimers() }
  })
  it("rejects a revoked token inside the transaction without writing a turn", async () => {
    const { tx, context } = fixture()
    tx.researchParticipantToken.updateMany.mockResolvedValue({ count: 0 })
    await expect(appendParticipantVoiceEvent({ context, ...input })).rejects.toThrow("not authorized")
    expect(tx.researchTurn.create).not.toHaveBeenCalled()
  })
  it("rejects a skipped ordinal rather than silently reordering evidence", async () => {
    const { context } = fixture()
    await expect(appendParticipantVoiceEvent({ context, ...input, reportedOrdinal: 2 })).rejects.toThrow("order")
  })
  it("rejects a late PM voice event after the exact lease is durably settled", async () => {
    const { context, tx } = fixture()
    const settledLeaseId = "00000000-0000-4000-8000-000000000050"
    context.study.studyType = "PM_INTERVIEW"
    tx.pMInterview.findUnique.mockResolvedValue({ transitionReceiptJson: JSON.stringify({ version: 1, phase: "SETTLED", leaseId: settledLeaseId, settlement: "FINALIZED", finalizedEventCount: 0, lastFinalizedOrdinal: null, at: "2026-09-11T12:00:00.000Z" }) })
    await expect(appendParticipantVoiceEvent({ context, ...input, leaseId: settledLeaseId })).rejects.toThrow("already settled")
    expect(tx.researchTurn.create).not.toHaveBeenCalled()
    expect(tx.researchParticipantVoiceEvent.create).not.toHaveBeenCalled()
  })
  it("rejects retries that omit the attachment from the original event", async () => {
    const { tx, context } = fixture()
    tx.researchParticipantVoiceEvent.findUnique.mockResolvedValue({ ...input, workspaceId: "workspace", claimedSpeaker: input.role, turnId: "turn" } as never)
    tx.researchAttachment.findMany.mockResolvedValue([{ id: "attachment" }] as never)
    await expect(appendParticipantVoiceEvent({ context, ...input })).rejects.toThrow("attachment")
  })
  it("limits total issuance claims, including ambiguous failures", async () => {
    const { context, session } = fixture()
    session.voiceAttemptCount = 5
    session.voiceLeaseExpiresAt = new Date(0)
    await expect(claimParticipantVoiceLease({ context, sessionId: "session", resumeToken: "resume" })).rejects.toThrow("reconnect limit")
  })
  it("preserves the participant link's daily voice issuance bound across sessions", async () => {
    const { context, session, tx } = fixture()
    session.voiceLeaseExpiresAt = new Date(0)
    tx.researchParticipantToken.findFirst.mockResolvedValue({ id: "token", voiceDayAt: new Date(), voiceDayCount: 20 } as never)
    await expect(claimParticipantVoiceLease({ context, sessionId: "session", resumeToken: "resume" })).rejects.toThrow("daily")
  })
})
