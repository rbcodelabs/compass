import { randomUUID } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import { isResearchAuthoritativeVoiceEnabled } from "@/lib/research-feature"
import { hashResearchResumeToken } from "@/lib/research-session"
import {
  ResearchVoiceControlPlaneError,
  type ResearchVoiceCallStatus,
  voiceWorkerTokenIsBound,
} from "@/lib/research-voice-control-plane"

const COMMAND_CLAIM_MS = 30_000
const MAX_COMMAND_ATTEMPTS = 3
const MAX_PENDING_COMMANDS = 20
const MAX_TOTAL_COMMANDS = 100
const MAX_COMMANDS_PER_MINUTE = 10
type VoiceOperationsPrisma = Pick<PrismaClient, "$transaction" | "researchVoiceCall" | "researchVoiceCommand">
type ParticipantVoicePrisma = Pick<PrismaClient,
  "$transaction" | "researchSession" | "researchVoiceCall" | "researchVoiceCommand" |
  "researchAttachment" | "researchParticipantToken">

function requireAuthoritativeVoice() {
  if (!isResearchAuthoritativeVoiceEnabled()) {
    throw new ResearchVoiceControlPlaneError("Authoritative voice is unavailable", 404, "VOICE_DISABLED")
  }
}

export async function authorizeResearchVoiceWorker({
  prisma,
  callId,
  rawToken,
  now = new Date(),
}: {
  prisma: Pick<PrismaClient, "researchVoiceCall">
  callId: string
  rawToken: string
  now?: Date
}) {
  requireAuthoritativeVoice()
  const call = await prisma.researchVoiceCall.findUnique({
    where: { id: callId },
    select: {
      id: true, sessionId: true, participantTokenId: true, workerTokenHash: true,
      status: true, transcriptIntegrity: true, leaseExpiresAt: true,
      nextProviderOrdinal: true, lastProviderItemId: true, lastHeartbeatAt: true,
      commandPendingCount: true,
    },
  })
  if (!call || !voiceWorkerTokenIsBound({
    rawToken,
    expectedTokenHash: call.workerTokenHash,
    presentedCallId: callId,
    expectedCallId: call.id,
    callStatus: call.status,
    expiresAt: call.leaseExpiresAt,
    now,
  })) throw new ResearchVoiceControlPlaneError("Invalid research voice worker token", 401, "INVALID_WORKER_TOKEN")
  return { ...call, status: call.status as ResearchVoiceCallStatus }
}

export async function recordResearchVoiceHeartbeat({
  prisma,
  callId,
  rawToken,
  now = new Date(),
}: {
  prisma: VoiceOperationsPrisma
  callId: string
  rawToken: string
  now?: Date
}) {
  const call = await authorizeResearchVoiceWorker({ prisma, callId, rawToken, now })
  const updated = await prisma.researchVoiceCall.updateMany({
    where: { id: callId, workerTokenHash: call.workerTokenHash, status: call.status, leaseExpiresAt: { gt: now } },
    data: { lastHeartbeatAt: now, updatedAt: now },
  })
  if (updated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice heartbeat changed concurrently", 409, "HEARTBEAT_RACE")
  return { accepted: true as const }
}

export async function claimResearchVoiceCommand({
  prisma,
  callId,
  rawToken,
  now = new Date(),
}: {
  prisma: VoiceOperationsPrisma
  callId: string
  rawToken: string
  now?: Date
}) {
  return prisma.$transaction(async (tx) => {
    const call = await authorizeResearchVoiceWorker({ prisma: tx, callId, rawToken, now })
    const fenced = await tx.researchVoiceCall.updateMany({
      where: { id: callId, sessionId: call.sessionId, status: call.status, workerTokenHash: call.workerTokenHash, leaseExpiresAt: { gt: now } },
      data: { updatedAt: now },
    })
    if (fenced.count !== 1) throw new ResearchVoiceControlPlaneError("Voice call changed concurrently", 409, "COMMAND_CLAIM_RACE")
    const exhausted = await tx.researchVoiceCommand.findFirst({
      where: {
        voiceCallId: callId, sessionId: call.sessionId, status: "CLAIMED",
        claimExpiresAt: { lte: now }, attemptCount: { gte: MAX_COMMAND_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
    })
    if (exhausted && exhausted.status === "CLAIMED" && exhausted.attemptCount >= MAX_COMMAND_ATTEMPTS &&
        exhausted.claimExpiresAt && exhausted.claimExpiresAt <= now) {
      const exhaustedUpdated = await tx.researchVoiceCommand.updateMany({
        where: {
          id: exhausted.id, voiceCallId: callId, sessionId: call.sessionId,
          status: "CLAIMED", attemptCount: exhausted.attemptCount, claimExpiresAt: exhausted.claimExpiresAt,
        },
        data: { status: "FAILED", claimExpiresAt: null, errorCode: "COMMAND_ATTEMPTS_EXHAUSTED", updatedAt: now },
      })
      if (exhaustedUpdated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice command changed concurrently", 409, "COMMAND_CLAIM_RACE")
      const pendingUpdated = await tx.researchVoiceCall.updateMany({
        where: { id: callId, status: call.status, commandPendingCount: call.commandPendingCount },
        data: { commandPendingCount: { decrement: 1 }, updatedAt: now },
      })
      if (pendingUpdated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice command counters changed concurrently", 409, "COMMAND_CLAIM_RACE")
      return null
    }
    const eligible = {
      voiceCallId: callId,
      sessionId: call.sessionId,
      attemptCount: { lt: MAX_COMMAND_ATTEMPTS },
      OR: [{ status: "PENDING" }, { status: "CLAIMED", claimExpiresAt: { lte: now } }],
    } satisfies Prisma.ResearchVoiceCommandWhereInput
    const command = await tx.researchVoiceCommand.findFirst({
      where: {
        ...eligible,
        kind: "HANGUP",
      },
      orderBy: { createdAt: "asc" },
    }) ?? await tx.researchVoiceCommand.findFirst({ where: eligible, orderBy: { createdAt: "asc" } })
    if (!command) return null
    const claimExpiresAt = new Date(now.getTime() + COMMAND_CLAIM_MS)
    const updated = await tx.researchVoiceCommand.updateMany({
      where: {
        id: command.id,
        voiceCallId: callId,
        sessionId: call.sessionId,
        status: command.status,
        attemptCount: command.attemptCount,
        claimExpiresAt: command.claimExpiresAt,
      },
      data: { status: "CLAIMED", attemptCount: { increment: 1 }, claimExpiresAt, errorCode: null, updatedAt: now },
    })
    if (updated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice command changed concurrently", 409, "COMMAND_CLAIM_RACE")
    return {
      id: command.id,
      kind: command.kind,
      attachmentId: command.attachmentId,
      claimEpoch: command.attemptCount + 1,
      claimExpiresAt,
    }
  })
}

export async function completeResearchVoiceCommand({
  prisma,
  callId,
  commandId,
  rawToken,
  claimEpoch,
  outcome,
  errorCode,
  now = new Date(),
}: {
  prisma: VoiceOperationsPrisma
  callId: string
  commandId: string
  rawToken: string
  claimEpoch: number
  outcome: "APPLIED" | "FAILED"
  errorCode?: string
  now?: Date
}) {
  if (errorCode && (errorCode.length > 50 || !/^[A-Z0-9_]+$/.test(errorCode))) {
    throw new ResearchVoiceControlPlaneError("Invalid voice command error code", 400, "INVALID_ERROR_CODE")
  }
  return prisma.$transaction(async (tx) => {
    const call = await authorizeResearchVoiceWorker({ prisma: tx, callId, rawToken, now })
    const command = await tx.researchVoiceCommand.findUnique({ where: { id: commandId } })
    const finalErrorCode = outcome === "FAILED" ? (errorCode ?? "WORKER_COMMAND_FAILED") : null
    if (command?.voiceCallId === callId && command.sessionId === call.sessionId && command.attemptCount === claimEpoch &&
        command.status === outcome && command.errorCode === finalErrorCode && command.claimExpiresAt === null) {
      return { status: outcome }
    }
    if (!command || command.voiceCallId !== callId || command.sessionId !== call.sessionId ||
        command.status !== "CLAIMED" || command.attemptCount !== claimEpoch ||
        !command.claimExpiresAt || command.claimExpiresAt <= now) {
      throw new ResearchVoiceControlPlaneError("Voice command claim is stale", 409, "STALE_COMMAND_CLAIM")
    }
    const updated = await tx.researchVoiceCommand.updateMany({
      where: {
        id: commandId, voiceCallId: callId, sessionId: call.sessionId,
        status: "CLAIMED", attemptCount: claimEpoch, claimExpiresAt: command.claimExpiresAt,
      },
      data: { status: outcome, claimExpiresAt: null, errorCode: outcome === "FAILED" ? (errorCode ?? "WORKER_COMMAND_FAILED") : null, updatedAt: now },
    })
    if (updated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice command claim is stale", 409, "STALE_COMMAND_CLAIM")
    const pendingUpdated = await tx.researchVoiceCall.updateMany({
      where: { id: callId, sessionId: call.sessionId, status: call.status, workerTokenHash: call.workerTokenHash, leaseExpiresAt: { gt: now }, commandPendingCount: call.commandPendingCount },
      data: { commandPendingCount: { decrement: 1 }, updatedAt: now },
    })
    if (pendingUpdated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice command counters changed concurrently", 409, "STALE_COMMAND_CLAIM")
    return { status: outcome }
  })
}

export async function authorizeResearchVoiceParticipant({
  prisma,
  sessionId,
  participantTokenId,
  resumeToken,
  allowTerminal = false,
}: {
  prisma: Pick<PrismaClient, "researchSession">
  sessionId: string
  participantTokenId: string
  resumeToken: string
  allowTerminal?: boolean
}) {
  requireAuthoritativeVoice()
  const session = await prisma.researchSession.findFirst({
    where: {
      id: sessionId,
      participantTokenId,
      resumeTokenHash: hashResearchResumeToken(resumeToken),
      status: allowTerminal ? { in: ["IN_PROGRESS", "COMPLETED"] } : "IN_PROGRESS",
      modality: "VOICE",
    },
    select: { id: true, status: true, voiceLeaseId: true },
  })
  if (!session) throw new ResearchVoiceControlPlaneError("Voice session not found", 404, "SESSION_NOT_FOUND")
  return session
}

export async function getParticipantResearchVoiceCall({
  prisma,
  callId,
  sessionId,
  participantTokenId,
  resumeToken,
}: {
  prisma: ParticipantVoicePrisma
  callId: string
  sessionId: string
  participantTokenId: string
  resumeToken: string
}) {
  await authorizeResearchVoiceParticipant({ prisma, sessionId, participantTokenId, resumeToken, allowTerminal: true })
  const call = await prisma.researchVoiceCall.findFirst({
    where: { id: callId, sessionId, participantTokenId },
    select: {
      id: true, status: true, transcriptIntegrity: true, leaseExpiresAt: true,
      connectedAt: true, endedAt: true, errorCode: true,
    },
  })
  if (!call) throw new ResearchVoiceControlPlaneError("Voice call not found", 404, "CALL_NOT_FOUND")
  return call
}

export async function enqueueResearchVoiceCommand({
  prisma,
  sessionId,
  participantTokenId,
  resumeToken,
  callId,
  idempotencyKey,
  kind,
  attachmentId = null,
  now = new Date(),
}: {
  prisma: ParticipantVoicePrisma
  sessionId: string
  participantTokenId: string
  resumeToken: string
  callId: string
  idempotencyKey: string
  kind: "HANGUP" | "ATTACHMENT_ADDED"
  attachmentId?: string | null
  now?: Date
}) {
  if (!["HANGUP", "ATTACHMENT_ADDED"].includes(kind) || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey) ||
      (kind === "ATTACHMENT_ADDED") !== Boolean(attachmentId)) {
    throw new ResearchVoiceControlPlaneError("Invalid voice command", 400, "INVALID_COMMAND")
  }
  try {
    return await prisma.$transaction(async (tx) => {
    const session = await authorizeResearchVoiceParticipant({ prisma: tx, sessionId, participantTokenId, resumeToken, allowTerminal: true })
    const token = await tx.researchParticipantToken.findFirst({
      where: { id: participantTokenId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    })
    if (!token) throw new ResearchVoiceControlPlaneError("Participant token is unavailable", 404, "TOKEN_NOT_FOUND")
    const call = await tx.researchVoiceCall.findUnique({ where: { id: callId } })
    if (!call || call.sessionId !== sessionId || call.participantTokenId !== participantTokenId) {
      throw new ResearchVoiceControlPlaneError("Voice call is unavailable", 409, "CALL_UNAVAILABLE")
    }
    const existing = await tx.researchVoiceCommand.findUnique({
      where: { voiceCallId_idempotencyKey: { voiceCallId: callId, idempotencyKey } },
    })
    if (existing) {
      if (existing.sessionId !== sessionId || existing.kind !== kind || existing.attachmentId !== attachmentId) {
        throw new ResearchVoiceControlPlaneError("Command idempotency conflict", 409, "COMMAND_MISMATCH")
      }
      return { ...existing, replayed: true as const }
    }
    if (session.voiceLeaseId !== callId || session.status === "COMPLETED") {
      throw new ResearchVoiceControlPlaneError("Voice call binding mismatch", 409, "CALL_BINDING_MISMATCH")
    }
    if (kind === "ATTACHMENT_ADDED" && !["READY", "ACTIVE"].includes(call.status)) {
      throw new ResearchVoiceControlPlaneError("Voice call is unavailable", 409, "CALL_UNAVAILABLE")
    }
    if (kind === "HANGUP" && !["READY", "ACTIVE", "DISCONNECTING"].includes(call.status)) {
      throw new ResearchVoiceControlPlaneError("Voice call is unavailable", 409, "CALL_UNAVAILABLE")
    }
    if (attachmentId) {
      const attachment = await tx.researchAttachment.findFirst({
        where: { id: attachmentId, sessionId, status: "READY" },
        select: { id: true },
      })
      if (!attachment) throw new ResearchVoiceControlPlaneError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND")
    }
    const windowExpired = !call.commandWindowAt || now.getTime() - call.commandWindowAt.getTime() >= 60_000
    const windowCount = windowExpired ? 0 : call.commandWindowCount
    const coalescedHangup = kind === "HANGUP" ? call.hangupCommandId : null
    const becomesPending = !coalescedHangup
    const firstHangup = kind === "HANGUP" && !coalescedHangup
    // One safety command remains available after attachment quotas are exhausted.
    // Aliases still consume quota, so varying idempotency keys cannot grow without bound.
    if (!firstHangup && ((becomesPending && call.commandPendingCount >= MAX_PENDING_COMMANDS) ||
        call.commandTotalCount >= MAX_TOTAL_COMMANDS || windowCount >= MAX_COMMANDS_PER_MINUTE)) {
      throw new ResearchVoiceControlPlaneError("Voice command limit reached", 429, "COMMAND_LIMIT")
    }
    const tokenFenced = await tx.researchParticipantToken.updateMany({
      where: { id: participantTokenId, revokedAt: null, expiresAt: { gt: now } },
      data: { lastUsedAt: now },
    })
    if (tokenFenced.count !== 1) throw new ResearchVoiceControlPlaneError("Participant token changed concurrently", 409, "COMMAND_RACE")
    const sessionFenced = await tx.researchSession.updateMany({
      where: { id: sessionId, participantTokenId, status: "IN_PROGRESS", voiceLeaseId: callId },
      data: { updatedAt: now },
    })
    if (sessionFenced.count !== 1) throw new ResearchVoiceControlPlaneError("Voice session changed concurrently", 409, "COMMAND_RACE")
    const commandId = randomUUID()
    const nextStatus = kind === "HANGUP" && !coalescedHangup ? "DISCONNECTING" : call.status
    const reserved = await tx.researchVoiceCall.updateMany({
      where: {
        id: callId, sessionId, participantTokenId, status: call.status,
        transcriptIntegrity: call.transcriptIntegrity,
        commandPendingCount: call.commandPendingCount, commandTotalCount: call.commandTotalCount,
        commandWindowAt: call.commandWindowAt, commandWindowCount: call.commandWindowCount,
        hangupCommandId: call.hangupCommandId,
      },
      data: {
        status: nextStatus,
        ...(nextStatus !== call.status ? { statusChangedAt: now } : {}),
        commandPendingCount: becomesPending ? { increment: 1 } : call.commandPendingCount,
        commandTotalCount: { increment: 1 },
        commandWindowAt: windowExpired ? now : call.commandWindowAt,
        commandWindowCount: windowExpired ? 1 : { increment: 1 },
        ...(kind === "HANGUP" && !coalescedHangup ? { hangupCommandId: commandId } : {}),
        updatedAt: now,
      },
    })
    if (reserved.count !== 1) throw new ResearchVoiceControlPlaneError("Voice command changed concurrently", 409, "COMMAND_RACE")
    const command = await tx.researchVoiceCommand.create({
      data: {
        id: commandId, voiceCallId: callId, sessionId, idempotencyKey, kind, attachmentId,
        status: coalescedHangup ? "APPLIED" : "PENDING",
        canonicalCommandId: coalescedHangup,
        updatedAt: now,
      },
    })
    return { ...command, replayed: false as const, coalesced: Boolean(coalescedHangup) }
    })
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
    const concurrent = await prisma.researchVoiceCommand.findUnique({
      where: { voiceCallId_idempotencyKey: { voiceCallId: callId, idempotencyKey } },
    })
    if (!concurrent || concurrent.sessionId !== sessionId || concurrent.kind !== kind || concurrent.attachmentId !== attachmentId) {
      throw new ResearchVoiceControlPlaneError("Command idempotency conflict", 409, "COMMAND_MISMATCH")
    }
    return { ...concurrent, replayed: true as const }
  }
}
