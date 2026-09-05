import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import {
  authorizeResearchVoiceWorker,
  claimResearchVoiceCommand,
  completeResearchVoiceCommand,
  enqueueResearchVoiceCommand,
  getParticipantResearchVoiceCall,
  recordResearchVoiceHeartbeat,
} from "@/lib/research-voice-operations"
import { createVoiceWorkerCredential } from "@/lib/research-voice-control-plane"

function fixture() {
  const credential = createVoiceWorkerCredential()
  const call = {
    id: "call-1", sessionId: "session-1", participantTokenId: "token-1",
    workerTokenHash: credential.tokenHash, status: "ACTIVE", transcriptIntegrity: "PENDING",
    leaseExpiresAt: new Date("2026-09-05T12:10:00Z"), nextProviderOrdinal: 2,
    lastProviderItemId: "item-1", lastHeartbeatAt: null,
    commandPendingCount: 0, commandTotalCount: 0, commandWindowAt: null,
    commandWindowCount: 0, hangupCommandId: null,
  }
  const command = {
    id: "command-1", voiceCallId: "call-1", sessionId: "session-1", kind: "HANGUP",
    attachmentId: null, status: "PENDING", attemptCount: 0, claimExpiresAt: null,
  }
  const tx = {
    researchVoiceCall: {
      findUnique: vi.fn().mockResolvedValue(call),
      findFirst: vi.fn().mockResolvedValue(call),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    researchVoiceCommand: {
      findFirst: vi.fn().mockResolvedValue(command),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ ...command, status: "CLAIMED", attemptCount: 1 }),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    researchParticipantToken: { findFirst: vi.fn().mockResolvedValue({ id: "token-1" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  const prisma = { ...tx, $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
  return { prisma, tx, credential, call, command }
}

describe("research voice worker operations", () => {
  beforeEach(() => vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1"))
  afterEach(() => vi.unstubAllEnvs())

  it("authenticates the raw callback bearer only against its live call hash and lease", async () => {
    const { prisma, credential } = fixture()
    await expect(authorizeResearchVoiceWorker({
      prisma: prisma as never, callId: "call-1", rawToken: credential.rawToken,
      now: new Date("2026-09-05T12:00:00Z"),
    })).resolves.toMatchObject({ id: "call-1" })
    await expect(authorizeResearchVoiceWorker({
      prisma: prisma as never, callId: "call-1", rawToken: "wrong",
      now: new Date("2026-09-05T12:00:00Z"),
    })).rejects.toMatchObject({ status: 401, code: "INVALID_WORKER_TOKEN" })
  })

  it("records heartbeats with a fenced live-call update", async () => {
    const { prisma, tx, credential } = fixture()
    const now = new Date("2026-09-05T12:00:00Z")
    await recordResearchVoiceHeartbeat({ prisma: prisma as never, callId: "call-1", rawToken: credential.rawToken, now })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith({
      where: { id: "call-1", workerTokenHash: credential.tokenHash, status: "ACTIVE", leaseExpiresAt: { gt: now } },
      data: { lastHeartbeatAt: now, updatedAt: now },
    })
  })

  it("uses attempt count as the durable claim epoch and rejects a stale result", async () => {
    const { prisma, tx, credential } = fixture()
    const now = new Date("2026-09-05T12:00:00Z")
    await expect(claimResearchVoiceCommand({
      prisma: prisma as never, callId: "call-1", rawToken: credential.rawToken, now,
    })).resolves.toMatchObject({ id: "command-1", claimEpoch: 1, kind: "HANGUP" })
    expect(tx.researchVoiceCommand.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "command-1", status: "PENDING", attemptCount: 0 }),
      data: expect.objectContaining({ status: "CLAIMED", attemptCount: { increment: 1 } }),
    }))

    tx.researchVoiceCommand.findUnique.mockResolvedValueOnce({
      ...tx.researchVoiceCommand.findUnique.getMockImplementation?.(),
      id: "command-1", voiceCallId: "call-1", sessionId: "session-1", status: "CLAIMED", attemptCount: 2,
    })
    await expect(completeResearchVoiceCommand({
      prisma: prisma as never, callId: "call-1", commandId: "command-1",
      rawToken: credential.rawToken, claimEpoch: 1, outcome: "APPLIED", now,
    })).rejects.toMatchObject({ code: "STALE_COMMAND_CLAIM" })
  })

  it("binds participant status and attachment commands to the resume credential and active call", async () => {
    const { prisma, tx, call } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", voiceLeaseId: "call-1" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    const researchAttachment = { findFirst: vi.fn().mockResolvedValue({ id: "attachment-1" }) }
    Object.assign(prisma, { researchSession, researchAttachment })
    Object.assign(tx, { researchSession, researchAttachment })
    tx.researchVoiceCommand.findUnique = vi.fn().mockResolvedValue(null)
    tx.researchVoiceCommand.create.mockResolvedValue({ id: "command-2", status: "PENDING" })
    tx.researchVoiceCall.findFirst.mockResolvedValue(call)
    await expect(getParticipantResearchVoiceCall({
      prisma: prisma as never, callId: "call-1", sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
    })).resolves.toMatchObject({ id: call.id, status: "ACTIVE" })
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "attachment-command-1", kind: "ATTACHMENT_ADDED", attachmentId: "attachment-1",
    })).resolves.toMatchObject({ id: "command-2", replayed: false })
    expect(tx.researchVoiceCommand.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      voiceCallId: "call-1", sessionId: "session-1", attachmentId: "attachment-1", kind: "ATTACHMENT_ADDED",
    }) })
  })

  it("preserves terminal status acknowledgement after lease release and binds the explicit call id", async () => {
    const { prisma, tx, call } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", voiceLeaseId: null }) }
    Object.assign(prisma, { researchSession })
    Object.assign(tx, { researchSession })
    tx.researchVoiceCall.findFirst.mockResolvedValue({ ...call, status: "COMPLETED" })
    await expect(getParticipantResearchVoiceCall({
      prisma: prisma as never, callId: "call-1", sessionId: "session-1",
      participantTokenId: "token-1", resumeToken: "resume",
    })).resolves.toMatchObject({ id: "call-1", status: "COMPLETED" })
    expect(tx.researchVoiceCall.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "call-1", sessionId: "session-1", participantTokenId: "token-1" },
    }))
  })

  it("transactionally rejects commands after participant-token revocation", async () => {
    const { prisma, tx } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", voiceLeaseId: "call-1" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    const researchAttachment = { findFirst: vi.fn() }
    Object.assign(prisma, { researchSession, researchAttachment })
    Object.assign(tx, { researchSession, researchAttachment })
    tx.researchParticipantToken.findFirst.mockResolvedValue(null)
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-command-0001", kind: "HANGUP",
    })).rejects.toMatchObject({ code: "TOKEN_NOT_FOUND" })
    expect(tx.researchVoiceCommand.create).not.toHaveBeenCalled()
  })

  it("turns the first HANGUP into a singleton DISCONNECTING barrier", async () => {
    const { prisma, tx } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", voiceLeaseId: "call-1" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    const researchAttachment = { findFirst: vi.fn() }
    Object.assign(prisma, { researchSession, researchAttachment })
    Object.assign(tx, { researchSession, researchAttachment })
    tx.researchVoiceCommand.findUnique.mockResolvedValue(null)
    tx.researchVoiceCommand.findFirst.mockResolvedValue(null)
    tx.researchVoiceCommand.create.mockResolvedValue({ id: "hangup-1", status: "PENDING" })
    await enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-hangup-0001", kind: "HANGUP",
    })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "call-1", status: "ACTIVE", transcriptIntegrity: "PENDING" }),
      data: expect.objectContaining({ status: "DISCONNECTING" }),
    }))
  })

  it("does not claim a terminal call or a command after its bounded attempts", async () => {
    const { prisma, tx, credential, call, command } = fixture()
    tx.researchVoiceCall.findUnique.mockResolvedValueOnce({ ...call, status: "COMPLETED" })
    await expect(claimResearchVoiceCommand({
      prisma: prisma as never, callId: "call-1", rawToken: credential.rawToken,
      now: new Date("2026-09-05T12:00:00Z"),
    })).rejects.toMatchObject({ code: "INVALID_WORKER_TOKEN" })
    tx.researchVoiceCall.findUnique.mockResolvedValue({ ...call })
    tx.researchVoiceCommand.findFirst.mockResolvedValue({ ...command, status: "CLAIMED", attemptCount: 3, claimExpiresAt: new Date(0) })
    await expect(claimResearchVoiceCommand({
      prisma: prisma as never, callId: "call-1", rawToken: credential.rawToken,
      now: new Date("2026-09-05T12:00:00Z"),
    })).resolves.toBeNull()
    expect(tx.researchVoiceCommand.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "COMMAND_ATTEMPTS_EXHAUSTED" }),
    }))
  })

  it("rejects a claim when terminalization wins the call write fence", async () => {
    const { prisma, tx, credential } = fixture()
    tx.researchVoiceCall.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimResearchVoiceCommand({
      prisma: prisma as never, callId: "call-1", rawToken: credential.rawToken,
      now: new Date("2026-09-05T12:00:00Z"),
    })).rejects.toMatchObject({ code: "COMMAND_CLAIM_RACE" })
    expect(tx.researchVoiceCommand.updateMany).not.toHaveBeenCalled()
  })

  it("replays a bound command receipt after the session completes and its lease is released", async () => {
    const { prisma, tx, call, command } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", status: "COMPLETED", voiceLeaseId: null }) }
    Object.assign(prisma, { researchSession })
    Object.assign(tx, { researchSession })
    tx.researchVoiceCall.findUnique.mockResolvedValue({ ...call, status: "COMPLETED" })
    tx.researchVoiceCommand.findUnique.mockResolvedValue({ ...command, status: "APPLIED" })
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-hangup-0001", kind: "HANGUP",
    })).resolves.toMatchObject({ id: command.id, replayed: true })
    expect(researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["IN_PROGRESS", "COMPLETED"] } }),
    }))
    expect(tx.researchVoiceCommand.create).not.toHaveBeenCalled()
  })

  it("rejects an unknown runtime command kind before database access", async () => {
    const { prisma } = fixture()
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-command-0001", kind: "OTHER" as never,
    })).rejects.toMatchObject({ code: "INVALID_COMMAND" })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("reserves the singleton hangup even when all attachment command quotas are exhausted", async () => {
    const { prisma, tx, call } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", status: "IN_PROGRESS", voiceLeaseId: "call-1" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    Object.assign(prisma, { researchSession })
    Object.assign(tx, { researchSession })
    tx.researchVoiceCall.findUnique.mockResolvedValue({
      ...call, transcriptIntegrity: "DEGRADED", commandPendingCount: 20, commandTotalCount: 100,
      commandWindowAt: new Date("2026-09-05T12:00:00Z"), commandWindowCount: 10,
    })
    tx.researchVoiceCommand.findUnique.mockResolvedValue(null)
    tx.researchVoiceCommand.create.mockResolvedValue({ id: "hangup-1", status: "PENDING" })
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-hangup-0001", kind: "HANGUP",
      now: new Date("2026-09-05T12:00:01Z"),
    })).resolves.toMatchObject({ id: "hangup-1" })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "DISCONNECTING", commandPendingCount: { increment: 1 } }),
    }))
  })

  it("releases the pending counter once and acknowledges an exact result retry", async () => {
    const { prisma, tx, credential, command } = fixture()
    const now = new Date("2026-09-05T12:00:00Z")
    tx.researchVoiceCommand.findUnique.mockResolvedValue({ ...command, status: "CLAIMED", attemptCount: 1, claimExpiresAt: new Date("2026-09-05T12:00:20Z") })
    const input = { prisma: prisma as never, callId: "call-1", commandId: command.id, rawToken: credential.rawToken, claimEpoch: 1, outcome: "APPLIED" as const, now }
    await expect(completeResearchVoiceCommand(input)).resolves.toEqual({ status: "APPLIED" })
    tx.researchVoiceCommand.findUnique.mockResolvedValue({ ...command, status: "APPLIED", attemptCount: 1, claimExpiresAt: null, errorCode: null })
    await expect(completeResearchVoiceCommand(input)).resolves.toEqual({ status: "APPLIED" })
    await expect(completeResearchVoiceCommand({ ...input, outcome: "FAILED" })).rejects.toMatchObject({ code: "STALE_COMMAND_CLAIM" })
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ commandPendingCount: { decrement: 1 } }) }))
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sessionId: "session-1", workerTokenHash: credential.tokenHash, leaseExpiresAt: { gt: now } }) }))
  })

  it("reads a concurrent idempotent receipt only after the failed transaction has rolled back", async () => {
    const { prisma, tx, command } = fixture()
    const researchSession = { findFirst: vi.fn().mockResolvedValue({ id: "session-1", voiceLeaseId: "call-1" }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    Object.assign(prisma, { researchSession })
    Object.assign(tx, { researchSession })
    let transactionOpen = false
    prisma.$transaction.mockImplementation(async (fn) => {
      transactionOpen = true
      try { return await fn(tx) } finally { transactionOpen = false }
    })
    tx.researchVoiceCommand.findUnique.mockResolvedValueOnce(null).mockImplementation(async () => {
      expect(transactionOpen).toBe(false)
      return { ...command, status: "PENDING" }
    })
    tx.researchVoiceCommand.create.mockRejectedValue({ code: "P2002" })
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-hangup-0001", kind: "HANGUP",
    })).resolves.toMatchObject({ id: command.id, replayed: true })
  })

  it.each(["token", "session", "call"])("creates no command when the %s write fence loses", async (fence) => {
    const { prisma, tx } = fixture()
    const researchSession = {
      findFirst: vi.fn().mockResolvedValue({ id: "session-1", voiceLeaseId: "call-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: fence === "session" ? 0 : 1 }),
    }
    Object.assign(prisma, { researchSession })
    Object.assign(tx, { researchSession })
    tx.researchVoiceCommand.findUnique.mockResolvedValue(null)
    if (fence === "token") tx.researchParticipantToken.updateMany.mockResolvedValue({ count: 0 })
    if (fence === "call") tx.researchVoiceCall.updateMany.mockResolvedValue({ count: 0 })
    await expect(enqueueResearchVoiceCommand({
      prisma: prisma as never, sessionId: "session-1", participantTokenId: "token-1", resumeToken: "resume",
      callId: "call-1", idempotencyKey: "voice-hangup-0001", kind: "HANGUP",
    })).rejects.toMatchObject({ code: "COMMAND_RACE" })
    expect(tx.researchVoiceCommand.create).not.toHaveBeenCalled()
  })
})
