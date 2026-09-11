import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { AppPrismaClient } from "@/lib/db"
import { isResearchAuthoritativeVoiceEnabled } from "@/lib/research-feature"
import { terminateResearchVoiceCall, type ResearchVoiceCleanup } from "@/lib/research-voice-termination"

export const MAX_RESEARCH_VOICE_ATTEMPTS_PER_MINUTE = 5
export const MAX_RESEARCH_VOICE_ATTEMPTS_PER_DAY = 20
export const MAX_RESEARCH_VOICE_ATTEMPTS_PER_SESSION = 8
export const MAX_RESEARCH_VOICE_TURNS = 50
export const MAX_RESEARCH_VOICE_TRANSCRIPT_CHARS = 60_000
export const RESEARCH_VOICE_ANSWER_RETENTION_MS = 60_000
export const MAX_RESEARCH_VOICE_TARGET_MINUTES = 30
export const RESEARCH_VOICE_LEASE_GRACE_MINUTES = 5
export const MAX_RESEARCH_VOICE_LEASE_MS = 35 * 60_000
export const MAX_RESEARCH_VOICE_CALLBACK_EVENTS = 10
export const MAX_RESEARCH_VOICE_CALLBACK_BYTES = 64 * 1024

export const RESEARCH_VOICE_CALL_STATUSES = [
  "PROVISIONING",
  "PROVIDER_CREATED",
  "WORKER_STARTING",
  "READY",
  "ACTIVE",
  "DISCONNECTING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "UNKNOWN",
] as const

export type ResearchVoiceCallStatus = typeof RESEARCH_VOICE_CALL_STATUSES[number]
export type ResearchVoiceTranscriptIntegrity = "PENDING" | "COMPLETE" | "DEGRADED"
export type ResearchVoiceCommandStatus = "PENDING" | "CLAIMED" | "APPLIED" | "FAILED"

const TERMINAL_CALL_STATUSES = new Set<ResearchVoiceCallStatus>([
  "COMPLETED", "FAILED", "EXPIRED", "UNKNOWN",
])

function assertVoiceCallStatus(status: string): asserts status is ResearchVoiceCallStatus {
  if (!(RESEARCH_VOICE_CALL_STATUSES as readonly string[]).includes(status)) {
    throw new ResearchVoiceControlPlaneError("Unknown research voice call status", 409, "UNKNOWN_CALL_STATUS")
  }
}

const CALL_TRANSITIONS: Record<ResearchVoiceCallStatus, readonly ResearchVoiceCallStatus[]> = {
  PROVISIONING: ["PROVIDER_CREATED", "FAILED", "EXPIRED", "UNKNOWN"],
  PROVIDER_CREATED: ["WORKER_STARTING", "FAILED", "EXPIRED", "UNKNOWN"],
  WORKER_STARTING: ["READY", "FAILED", "EXPIRED", "UNKNOWN"],
  READY: ["ACTIVE", "DISCONNECTING", "FAILED", "EXPIRED", "UNKNOWN"],
  ACTIVE: ["DISCONNECTING", "FAILED", "EXPIRED", "UNKNOWN"],
  DISCONNECTING: ["COMPLETED", "FAILED", "EXPIRED", "UNKNOWN"],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
  UNKNOWN: [],
}

export class ResearchVoiceControlPlaneError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = "ResearchVoiceControlPlaneError"
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function hashVoiceWorkerToken(rawToken: string) {
  return sha256(rawToken)
}

export function createVoiceWorkerCredential() {
  const rawToken = randomBytes(32).toString("base64url")
  return { rawToken, tokenHash: hashVoiceWorkerToken(rawToken) }
}

export function voiceWorkerTokenIsBound({
  rawToken,
  expectedTokenHash,
  presentedCallId,
  expectedCallId,
  callStatus,
  expiresAt,
  now,
}: {
  rawToken: string
  expectedTokenHash: string
  presentedCallId: string
  expectedCallId: string
  callStatus: string
  expiresAt: Date
  now: Date
}) {
  if (!(RESEARCH_VOICE_CALL_STATUSES as readonly string[]).includes(callStatus) ||
      TERMINAL_CALL_STATUSES.has(callStatus as ResearchVoiceCallStatus) ||
      presentedCallId !== expectedCallId || now >= expiresAt || !/^[a-f0-9]{64}$/.test(expectedTokenHash)) return false
  const actual = Buffer.from(hashVoiceWorkerToken(rawToken), "hex")
  const expected = Buffer.from(expectedTokenHash, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function voiceCallTransitionPatch(
  current: string,
  next: string,
  now: Date,
  options: { orderedBufferDrained?: boolean } = {},
) {
  assertVoiceCallStatus(current)
  assertVoiceCallStatus(next)
  if (!CALL_TRANSITIONS[current].includes(next)) {
    throw new ResearchVoiceControlPlaneError("Invalid research voice call transition", 409, "INVALID_TRANSITION")
  }
  if (next === "COMPLETED" && !options.orderedBufferDrained) {
    throw new ResearchVoiceControlPlaneError("Research voice transcript is not drained", 409, "TRANSCRIPT_NOT_DRAINED")
  }
  const base = { status: next, statusChangedAt: now, updatedAt: now }
  if (next === "ACTIVE") return { ...base, answerSdp: null, connectedAt: now }
  if (next === "COMPLETED") return { ...base, transcriptIntegrity: "COMPLETE" as const, endedAt: now }
  if (TERMINAL_CALL_STATUSES.has(next)) return { ...base, transcriptIntegrity: "DEGRADED" as const, endedAt: now }
  return base
}

export function voiceAnswerRetentionPatch(
  call: { status: ResearchVoiceCallStatus; answerSdp: string | null; createdAt: Date },
  now: Date,
  retentionMs = RESEARCH_VOICE_ANSWER_RETENTION_MS,
) {
  if (!call.answerSdp) return null
  if (call.status === "ACTIVE" || now.getTime() - call.createdAt.getTime() > retentionMs) {
    return { answerSdp: null, updatedAt: now }
  }
  return null
}

type VoiceControlPlanePrisma = Pick<AppPrismaClient, "$transaction">

function validIdempotencyKey(value: string) {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function windowState(start: Date | null, count: number | null, now: Date, durationMs: number) {
  const reset = !start || count === null || now.getTime() - start.getTime() >= durationMs
  return { start: reset ? now : start, count: reset ? 0 : (count ?? 0), reset }
}

export function researchVoiceLeaseExpiresAt(now: Date, targetMinutes: number) {
  if (!Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > MAX_RESEARCH_VOICE_TARGET_MINUTES) {
    throw new ResearchVoiceControlPlaneError("Invalid voice call lease", 400, "INVALID_LEASE")
  }
  return new Date(now.getTime() + (targetMinutes + RESEARCH_VOICE_LEASE_GRACE_MINUTES) * 60_000)
}

export async function allocateResearchVoiceCall({
  prisma,
  sessionId,
  participantTokenId,
  idempotencyKey,
  offerSdp,
  targetMinutes,
  now = new Date(),
}: {
  prisma: VoiceControlPlanePrisma
  sessionId: string
  participantTokenId: string
  idempotencyKey: string
  offerSdp: string
  targetMinutes: number
  now?: Date
}) {
  if (!isResearchAuthoritativeVoiceEnabled()) {
    throw new ResearchVoiceControlPlaneError("Authoritative voice is unavailable", 409, "VOICE_DISABLED")
  }
  if (!validIdempotencyKey(idempotencyKey) || !offerSdp.trim()) {
    throw new ResearchVoiceControlPlaneError("Invalid voice allocation request", 400, "INVALID_ALLOCATION")
  }
  const leaseExpiresAt = researchVoiceLeaseExpiresAt(now, targetMinutes)
  const offerSha256 = sha256(offerSdp)

  return prisma.$transaction(async (tx) => {
    const prior = await tx.researchVoiceCall.findUnique({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey } },
    })
    const session = await tx.researchSession.findFirst({
      where: { id: sessionId, participantTokenId, status: "IN_PROGRESS", modality: "VOICE" },
      select: {
        id: true,
        voiceLeaseId: true,
        voiceLeaseExpiresAt: true,
        voiceAttemptCount: true,
      },
    })
    if (!session) throw new ResearchVoiceControlPlaneError("Voice session not found", 404, "SESSION_NOT_FOUND")
    const participantToken = await tx.researchParticipantToken.findFirst({
      where: { id: participantTokenId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, voiceWindowAt: true, voiceCount: true, voiceDayAt: true, voiceDayCount: true },
    })
    if (!participantToken) {
      throw new ResearchVoiceControlPlaneError("Participant token is unavailable", 404, "TOKEN_NOT_FOUND")
    }

    if (prior) {
      assertVoiceCallStatus(prior.status)
      if (prior.sessionId !== sessionId || prior.participantTokenId !== participantTokenId || session.voiceLeaseId !== prior.id) {
        throw new ResearchVoiceControlPlaneError("Voice allocation replay is no longer available; use a new key", 409, "REPLAY_UNAVAILABLE")
      }
      if (prior.offerSha256 !== offerSha256) {
        throw new ResearchVoiceControlPlaneError("Idempotency key was reused with another offer", 409, "OFFER_MISMATCH")
      }
      if (TERMINAL_CALL_STATUSES.has(prior.status) || !prior.answerSdp || prior.leaseExpiresAt <= now) {
        throw new ResearchVoiceControlPlaneError("Voice allocation replay is no longer available; use a new key", 409, "REPLAY_UNAVAILABLE")
      }
      return { replayed: true as const, call: prior, workerToken: null }
    }
    if (session.voiceLeaseId !== null) {
      throw new ResearchVoiceControlPlaneError("Voice lease requires reconciliation", 409, "RECONCILIATION_REQUIRED")
    }

    const minute = windowState(participantToken.voiceWindowAt, participantToken.voiceCount, now, 60_000)
    const day = windowState(participantToken.voiceDayAt, participantToken.voiceDayCount, now, 24 * 60 * 60_000)
    const attemptNumber = (session.voiceAttemptCount ?? 0) + 1
    if (minute.count >= MAX_RESEARCH_VOICE_ATTEMPTS_PER_MINUTE ||
        day.count >= MAX_RESEARCH_VOICE_ATTEMPTS_PER_DAY ||
        attemptNumber > MAX_RESEARCH_VOICE_ATTEMPTS_PER_SESSION) {
      throw new ResearchVoiceControlPlaneError("Research voice attempt limit reached", 429, "VOICE_ATTEMPT_LIMIT")
    }

    const tokenUpdated = await tx.researchParticipantToken.updateMany({
      where: {
        id: participantTokenId,
        voiceWindowAt: participantToken.voiceWindowAt,
        voiceCount: participantToken.voiceCount,
        voiceDayAt: participantToken.voiceDayAt,
        voiceDayCount: participantToken.voiceDayCount,
      },
      data: {
        voiceWindowAt: minute.start,
        voiceCount: minute.reset ? 1 : { increment: 1 },
        voiceDayAt: day.start,
        voiceDayCount: day.reset ? 1 : { increment: 1 },
        lastUsedAt: now,
      },
    })
    if (tokenUpdated.count !== 1) {
      throw new ResearchVoiceControlPlaneError("Voice allocation changed concurrently", 409, "ALLOCATION_RACE")
    }

    const callId = randomUUID()
    const sessionUpdated = await tx.researchSession.updateMany({
      where: {
        id: sessionId,
        status: "IN_PROGRESS",
        modality: "VOICE",
        voiceLeaseId: session.voiceLeaseId,
        voiceLeaseExpiresAt: session.voiceLeaseExpiresAt,
        voiceAttemptCount: session.voiceAttemptCount,
      },
      data: {
        voiceLeaseId: callId,
        voiceLeaseExpiresAt: leaseExpiresAt,
        voiceAttemptCount: session.voiceAttemptCount === null ? 1 : { increment: 1 },
        lastActiveAt: now,
        updatedAt: now,
      },
    })
    if (sessionUpdated.count !== 1) {
      throw new ResearchVoiceControlPlaneError("A voice call is already active", 409, "LIVE_CALL_RACE")
    }

    const credential = createVoiceWorkerCredential()
    const call = await tx.researchVoiceCall.create({
      data: {
        id: callId,
        sessionId,
        participantTokenId,
        idempotencyKey,
        offerSha256,
        workerTokenHash: credential.tokenHash,
        status: "PROVISIONING",
        statusChangedAt: now,
        attemptNumber,
        leaseExpiresAt,
        transcriptIntegrity: "PENDING",
        updatedAt: now,
      },
    })
    return { replayed: false as const, call, workerToken: credential.rawToken }
  })
}

type CanonicalVoiceEvent = {
  voiceCallId: string
  sessionId: string
  providerEventId?: string
  providerResponseId?: string | null
  providerOrdinal: number
  providerItemId: string
  providerPreviousItemId: string | null
  providerStatus: string
  role: "PARTICIPANT" | "INTERVIEWER"
  content: string
}

function canonicalVoiceEventMatches(
  incoming: CanonicalVoiceEvent,
  stored: CanonicalVoiceEvent,
) {
  return incoming.voiceCallId === stored.voiceCallId && incoming.sessionId === stored.sessionId &&
    incoming.providerEventId === stored.providerEventId && incoming.providerOrdinal === stored.providerOrdinal &&
    incoming.providerItemId === stored.providerItemId && incoming.providerPreviousItemId === stored.providerPreviousItemId &&
    (incoming.providerResponseId ?? null) === (stored.providerResponseId ?? null) &&
    incoming.providerStatus === stored.providerStatus && incoming.role === stored.role && incoming.content === stored.content
}

function validateCanonicalVoiceBatchInput(voiceCallId: string, sessionId: string, events: CanonicalVoiceEvent[]) {
  if (events.length > MAX_RESEARCH_VOICE_CALLBACK_EVENTS) {
    throw new ResearchVoiceControlPlaneError("Research voice callback batch is too large", 413, "CALLBACK_BATCH_TOO_LARGE")
  }
  if (Buffer.byteLength(JSON.stringify(events), "utf8") > MAX_RESEARCH_VOICE_CALLBACK_BYTES) {
    throw new ResearchVoiceControlPlaneError("Research voice callback payload is too large", 413, "CALLBACK_PAYLOAD_TOO_LARGE")
  }
  for (const event of events) {
    if (event.voiceCallId !== voiceCallId || event.sessionId !== sessionId) {
      throw new ResearchVoiceControlPlaneError("Research voice callback binding mismatch", 409, "CALL_BINDING_MISMATCH")
    }
    if ((event.role !== "PARTICIPANT" && event.role !== "INTERVIEWER") ||
        !["COMPLETED", "FAILED", "CANCELLED", "INCOMPLETE"].includes(event.providerStatus) ||
        !Number.isInteger(event.providerOrdinal) || event.providerOrdinal < 0 ||
        event.providerItemId.length === 0 || event.providerItemId.length > 255 ||
        (event.providerEventId?.length ?? 0) > 255 ||
        (event.providerResponseId?.length ?? 0) > 255 ||
        (event.providerPreviousItemId?.length ?? 0) > 255 || event.providerStatus.length > 30 ||
        event.content.length > MAX_RESEARCH_VOICE_TRANSCRIPT_CHARS) {
      throw new ResearchVoiceControlPlaneError("Invalid research voice callback event", 400, "INVALID_CALLBACK_EVENT")
    }
  }
}

export function planCanonicalVoiceBatch({
  voiceCallId,
  sessionId,
  events,
  expectedOrdinal,
  previousProviderItemId,
  nextSequence,
  turnCount,
  transcriptChars,
}: {
  voiceCallId: string
  sessionId: string
  events: CanonicalVoiceEvent[]
  expectedOrdinal: number
  previousProviderItemId: string | null
  nextSequence: number
  turnCount: number
  transcriptChars: number
}) {
  validateCanonicalVoiceBatchInput(voiceCallId, sessionId, events)
  const ordinals = new Set<number>()
  const itemIds = new Set<string>()
  for (const event of events) {
    if (ordinals.has(event.providerOrdinal) || itemIds.has(event.providerItemId)) {
      return {
        acceptedOrdinals: [], turns: [], nextExpectedOrdinal: expectedOrdinal,
        transcriptIntegrity: "DEGRADED" as const, abortReason: "PROVIDER_COORDINATE_CONFLICT" as const,
      }
    }
    ordinals.add(event.providerOrdinal)
    itemIds.add(event.providerItemId)
  }
  const ordered = [...events].sort((left, right) => left.providerOrdinal - right.providerOrdinal)
  const acceptedOrdinals: number[] = []
  const turns: Array<{ providerOrdinal: number; sequence: number; role: "PARTICIPANT" | "INTERVIEWER"; content: string }> = []
  let ordinal = expectedOrdinal
  let priorItemId = previousProviderItemId
  let nextTurnCount = turnCount
  let nextTranscriptChars = transcriptChars
  let sequence = nextSequence

  for (const event of ordered) {
    if (event.providerOrdinal < ordinal) continue
    if (event.providerOrdinal > ordinal) break
    if (event.providerPreviousItemId !== priorItemId) {
      return {
        acceptedOrdinals,
        turns,
        nextExpectedOrdinal: ordinal,
        transcriptIntegrity: "DEGRADED" as const,
        abortReason: "PROVIDER_ORDER_BROKEN" as const,
      }
    }
    const terminal = ["COMPLETED", "FAILED", "CANCELLED", "INCOMPLETE"].includes(event.providerStatus)
    if (!terminal) break
    if (event.role === "PARTICIPANT" && event.providerStatus !== "COMPLETED") {
      return {
        acceptedOrdinals,
        turns,
        nextExpectedOrdinal: ordinal,
        transcriptIntegrity: "DEGRADED" as const,
        abortReason: "PARTICIPANT_TRANSCRIPTION_FAILED" as const,
      }
    }
    if (event.providerStatus === "COMPLETED") {
      const content = event.content.trim()
      if (!content) {
        return {
          acceptedOrdinals,
          turns,
          nextExpectedOrdinal: ordinal,
          transcriptIntegrity: "DEGRADED" as const,
          abortReason: "FINAL_CONTENT_MISSING" as const,
        }
      }
      if (nextTurnCount + 1 > MAX_RESEARCH_VOICE_TURNS ||
          nextTranscriptChars + Array.from(content).length > MAX_RESEARCH_VOICE_TRANSCRIPT_CHARS) {
        throw new ResearchVoiceControlPlaneError("Research voice transcript limit reached", 409, "TRANSCRIPT_LIMIT")
      }
      turns.push({ providerOrdinal: ordinal, sequence, role: event.role, content })
      sequence += 1
      nextTurnCount += 1
      nextTranscriptChars += Array.from(content).length
    }
    acceptedOrdinals.push(ordinal)
    ordinal += 1
    priorItemId = event.providerItemId
  }

  return {
    acceptedOrdinals,
    turns,
    nextExpectedOrdinal: ordinal,
    lastProviderItemId: priorItemId,
    nextTurnCount,
    nextTranscriptChars,
    sessionCas: {
      expected: { nextSequence, voiceTurnCount: turnCount, voiceTranscriptChars: transcriptChars },
      update: { nextSequence: sequence, voiceTurnCount: nextTurnCount, voiceTranscriptChars: nextTranscriptChars },
    },
    callCas: {
      expected: { id: voiceCallId, sessionId, nextProviderOrdinal: expectedOrdinal, lastProviderItemId: previousProviderItemId },
      update: { nextProviderOrdinal: ordinal, lastProviderItemId: priorItemId },
    },
    transactionalCas: {
      call: {
        expected: { id: voiceCallId, sessionId, nextProviderOrdinal: expectedOrdinal, lastProviderItemId: previousProviderItemId },
        update: { nextProviderOrdinal: ordinal, lastProviderItemId: priorItemId },
      },
      session: {
        expected: { nextSequence, voiceTurnCount: turnCount, voiceTranscriptChars: transcriptChars },
        update: { nextSequence: sequence, voiceTurnCount: nextTurnCount, voiceTranscriptChars: nextTranscriptChars },
      },
    },
    transcriptIntegrity: "PENDING" as const,
    abortReason: null,
  }
}

export async function appendCanonicalVoiceBatch({
  prisma,
  voiceCallId,
  sessionId,
  events,
  workerToken,
  now = new Date(),
}: {
  prisma: VoiceControlPlanePrisma
  voiceCallId: string
  sessionId: string
  events: CanonicalVoiceEvent[]
  workerToken?: string
  now?: Date
}) {
  validateCanonicalVoiceBatchInput(voiceCallId, sessionId, events)
  if (events.some((event) => !event.providerEventId)) {
    throw new ResearchVoiceControlPlaneError("Provider event IDs are required", 400, "INVALID_CALLBACK_EVENT")
  }
  return prisma.$transaction(async (tx) => {
    const call = await tx.researchVoiceCall.findFirst({
      where: { id: voiceCallId, sessionId },
      select: { id: true, sessionId: true, status: true, transcriptIntegrity: true, nextProviderOrdinal: true, lastProviderItemId: true, workerTokenHash: true, leaseExpiresAt: true },
    })
    if (!call) throw new ResearchVoiceControlPlaneError("Voice call not found", 404, "CALL_NOT_FOUND")
    if (workerToken !== undefined) {
      if (!isResearchAuthoritativeVoiceEnabled() || !voiceWorkerTokenIsBound({ rawToken: workerToken, expectedTokenHash: call.workerTokenHash, presentedCallId: voiceCallId, expectedCallId: call.id, callStatus: call.status, expiresAt: call.leaseExpiresAt, now })) {
        throw new ResearchVoiceControlPlaneError("Invalid research voice worker token", 401, "INVALID_WORKER_TOKEN")
      }
      const fenced = await tx.researchVoiceCall.updateMany({
        where: { id: voiceCallId, sessionId, status: call.status, workerTokenHash: call.workerTokenHash, leaseExpiresAt: { gt: now } },
        data: { updatedAt: now },
      })
      if (fenced.count !== 1) throw new ResearchVoiceControlPlaneError("Voice callback authorization changed concurrently", 409, "CALLBACK_RACE")
    }
    assertVoiceCallStatus(call.status)
    if (call.transcriptIntegrity !== "PENDING") {
      throw new ResearchVoiceControlPlaneError("Voice transcript is no longer appendable", 409, "TRANSCRIPT_DEGRADED")
    }
    if (call.status !== "ACTIVE" && call.status !== "DISCONNECTING") {
      throw new ResearchVoiceControlPlaneError("Voice call is not event-bearing", 409, "CALL_NOT_EVENT_BEARING")
    }
    const session = await tx.researchSession.findFirst({
      where: { id: sessionId, voiceLeaseId: voiceCallId, status: "IN_PROGRESS", modality: "VOICE" },
      select: { nextSequence: true, voiceTurnCount: true, voiceTranscriptChars: true },
    })
    if (!session) throw new ResearchVoiceControlPlaneError("Voice session binding is unavailable", 409, "CALL_BINDING_MISMATCH")
    const existingEvents = events.length === 0 ? [] : await tx.researchVoiceEvent.findMany({
      where: {
        sessionId,
        OR: [
          { providerEventId: { in: events.map((event) => event.providerEventId!) } },
          { voiceCallId, providerOrdinal: { in: events.map((event) => event.providerOrdinal) } },
          { voiceCallId, providerItemId: { in: events.map((event) => event.providerItemId) } },
        ],
      },
      select: {
        voiceCallId: true, sessionId: true, providerEventId: true, providerOrdinal: true,
        providerItemId: true, providerPreviousItemId: true, providerResponseId: true,
        providerStatus: true, role: true, content: true,
      },
    })
    const replayedEventIds: string[] = []
    const unseenEvents: CanonicalVoiceEvent[] = []
    let coordinateConflict = false
    for (const event of events) {
      const matches = existingEvents.filter((stored) => stored.providerEventId === event.providerEventId ||
        (stored.voiceCallId === voiceCallId && (stored.providerOrdinal === event.providerOrdinal || stored.providerItemId === event.providerItemId)))
      if (matches.length === 0) {
        unseenEvents.push(event)
      } else if (matches.length === 1 && canonicalVoiceEventMatches(event, matches[0] as CanonicalVoiceEvent)) {
        replayedEventIds.push(event.providerEventId!)
      } else {
        coordinateConflict = true
        break
      }
    }
    if (coordinateConflict) {
      const degraded = await tx.researchVoiceCall.updateMany({
        where: { id: voiceCallId, sessionId, status: call.status, transcriptIntegrity: "PENDING", nextProviderOrdinal: call.nextProviderOrdinal, lastProviderItemId: call.lastProviderItemId },
        data: { transcriptIntegrity: "DEGRADED", errorCode: "PROVIDER_COORDINATE_CONFLICT", updatedAt: now },
      })
      if (degraded.count !== 1) throw new ResearchVoiceControlPlaneError("Voice callback changed concurrently", 409, "CALLBACK_RACE")
      return {
        acceptedOrdinals: [], turns: [], nextExpectedOrdinal: call.nextProviderOrdinal,
        transcriptIntegrity: "DEGRADED" as const, abortReason: "PROVIDER_COORDINATE_CONFLICT" as const,
      }
    }
    const plan = planCanonicalVoiceBatch({
      voiceCallId,
      sessionId,
      events: unseenEvents,
      expectedOrdinal: call.nextProviderOrdinal,
      previousProviderItemId: call.lastProviderItemId,
      nextSequence: session.nextSequence ?? 0,
      turnCount: session.voiceTurnCount ?? 0,
      transcriptChars: session.voiceTranscriptChars ?? 0,
    })
    if (plan.transcriptIntegrity === "DEGRADED") {
      const degraded = await tx.researchVoiceCall.updateMany({
        where: { id: voiceCallId, sessionId, status: call.status, transcriptIntegrity: "PENDING", nextProviderOrdinal: call.nextProviderOrdinal, lastProviderItemId: call.lastProviderItemId },
        data: { transcriptIntegrity: "DEGRADED", errorCode: plan.abortReason, updatedAt: now },
      })
      if (degraded.count !== 1) throw new ResearchVoiceControlPlaneError("Voice callback changed concurrently", 409, "CALLBACK_RACE")
      return { ...plan, replayedEventIds }
    }
    if (plan.acceptedOrdinals.length === 0) return { ...plan, replayedEventIds }

    const callUpdated = await tx.researchVoiceCall.updateMany({
      where: { ...plan.callCas.expected, status: call.status, transcriptIntegrity: "PENDING" },
      data: { ...plan.callCas.update, lastProviderEventId: unseenEvents.find((event) => event.providerOrdinal === plan.acceptedOrdinals.at(-1))!.providerEventId, updatedAt: now },
    })
    if (callUpdated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice callback changed concurrently", 409, "CALLBACK_RACE")
    const sessionUpdated = await tx.researchSession.updateMany({
      where: { id: sessionId, voiceLeaseId: voiceCallId, status: "IN_PROGRESS", modality: "VOICE", ...plan.sessionCas.expected },
      data: { ...plan.sessionCas.update, lastActiveAt: now, updatedAt: now },
    })
    if (sessionUpdated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice transcript changed concurrently", 409, "CALLBACK_RACE")

    const accepted = new Set(plan.acceptedOrdinals)
    await tx.researchVoiceEvent.createMany({
      data: unseenEvents.filter((event) => accepted.has(event.providerOrdinal)).map((event) => ({
        voiceCallId, sessionId, providerEventId: event.providerEventId!, providerItemId: event.providerItemId,
        providerResponseId: event.providerResponseId ?? null, providerPreviousItemId: event.providerPreviousItemId,
        providerOrdinal: event.providerOrdinal, providerStatus: event.providerStatus, role: event.role,
        content: event.content, status: "FINAL",
      })),
    })
    if (plan.turns.length > 0) {
      await tx.researchTurn.createMany({
        data: plan.turns.map((turn) => ({ sessionId, sequence: turn.sequence, role: turn.role, content: turn.content })),
      })
    }
    return { ...plan, replayedEventIds }
  })
}

export function reconcileResearchVoiceCall(
  call: {
    status: ResearchVoiceCallStatus
    leaseExpiresAt: Date
    lastHeartbeatAt: Date | null
    statusChangedAt: Date
  },
  now: Date,
  heartbeatTimeoutMs = 45_000,
) {
  assertVoiceCallStatus(call.status)
  if (TERMINAL_CALL_STATUSES.has(call.status)) {
    return { callPatch: null, releaseVoiceLease: false }
  }
  if (call.leaseExpiresAt <= now) {
    return { callPatch: {
      status: "EXPIRED" as const, transcriptIntegrity: "DEGRADED" as const,
      endReason: "LEASE_EXPIRED", endedAt: now, statusChangedAt: now, updatedAt: now,
    }, releaseVoiceLease: false }
  }
  const expectsHeartbeat = ["WORKER_STARTING", "READY", "ACTIVE", "DISCONNECTING"].includes(call.status)
  const heartbeatReference = call.lastHeartbeatAt ?? call.statusChangedAt
  if (expectsHeartbeat && now.getTime() - heartbeatReference.getTime() >= heartbeatTimeoutMs) {
    return { callPatch: {
      status: call.status === "DISCONNECTING" ? "FAILED" as const : "UNKNOWN" as const,
      transcriptIntegrity: "DEGRADED" as const, endReason: "HEARTBEAT_STALE",
      endedAt: now, statusChangedAt: now, updatedAt: now,
    }, releaseVoiceLease: false }
  }
  return null
}

export async function transitionResearchVoiceCall({
  prisma,
  voiceCallId,
  sessionId,
  expectedStatus,
  expectedNextProviderOrdinal,
  expectedLastProviderItemId,
  nextStatus,
  orderedBufferDrained = false,
  now = new Date(),
}: {
  prisma: VoiceControlPlanePrisma
  voiceCallId: string
  sessionId: string
  expectedStatus: ResearchVoiceCallStatus
  expectedNextProviderOrdinal: number
  expectedLastProviderItemId: string | null
  nextStatus: ResearchVoiceCallStatus
  orderedBufferDrained?: boolean
  now?: Date
}) {
  return prisma.$transaction(async (tx) => {
    const call = await tx.researchVoiceCall.findFirst({
      where: { id: voiceCallId, sessionId },
      select: { status: true, transcriptIntegrity: true, nextProviderOrdinal: true, lastProviderItemId: true, providerStoppedAt: true, sandboxStoppedAt: true },
    })
    if (!call || call.status !== expectedStatus || call.nextProviderOrdinal !== expectedNextProviderOrdinal ||
        call.lastProviderItemId !== expectedLastProviderItemId) {
      throw new ResearchVoiceControlPlaneError("Voice call transition changed concurrently", 409, "TRANSITION_RACE")
    }
    if (nextStatus === "COMPLETED" && call.transcriptIntegrity !== "PENDING") {
      throw new ResearchVoiceControlPlaneError("Degraded transcript cannot complete", 409, "TRANSCRIPT_DEGRADED")
    }
    const callPatch = voiceCallTransitionPatch(expectedStatus, nextStatus, now, { orderedBufferDrained })
    const updated = await tx.researchVoiceCall.updateMany({
      where: {
        id: voiceCallId, sessionId, status: expectedStatus,
        transcriptIntegrity: call.transcriptIntegrity,
        providerStoppedAt: call.providerStoppedAt, sandboxStoppedAt: call.sandboxStoppedAt,
        nextProviderOrdinal: expectedNextProviderOrdinal, lastProviderItemId: expectedLastProviderItemId,
      },
      data: callPatch,
    })
    if (updated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice call transition changed concurrently", 409, "TRANSITION_RACE")
    const releaseVoiceLease = TERMINAL_CALL_STATUSES.has(nextStatus) && Boolean(call.providerStoppedAt && call.sandboxStoppedAt)
    if (releaseVoiceLease) {
      const released = await tx.researchSession.updateMany({
        where: { id: sessionId, voiceLeaseId: voiceCallId },
        data: { voiceLeaseId: null, voiceLeaseExpiresAt: null, updatedAt: now },
      })
      if (released.count !== 1) throw new ResearchVoiceControlPlaneError("Voice lease binding changed concurrently", 409, "TRANSITION_RACE")
    }
    return { callPatch, releaseVoiceLease }
  })
}

export async function reconcilePersistedResearchVoiceCall({
  prisma,
  voiceCallId,
  sessionId,
  now = new Date(),
  cleanup,
}: {
  prisma: VoiceControlPlanePrisma & Pick<AppPrismaClient, "researchVoiceCall">
  voiceCallId: string
  sessionId: string
  now?: Date
  cleanup?: ResearchVoiceCleanup
}) {
  const call = await prisma.$transaction(async (tx) => {
    return tx.researchVoiceCall.findFirst({
      where: { id: voiceCallId, sessionId },
    })
  })
  if (!call) throw new ResearchVoiceControlPlaneError("Voice call not found", 404, "CALL_NOT_FOUND")
  assertVoiceCallStatus(call.status)
  const reconciliation = reconcileResearchVoiceCall({ ...call, status: call.status }, now)
  if (!reconciliation) return { callPatch: null, releaseVoiceLease: false }
  return terminateResearchVoiceCall({
    prisma, callId: voiceCallId, sessionId, expected: call, cleanup, now,
    endReason: reconciliation.callPatch?.endReason ?? call.endReason ?? undefined,
    raceCode: "RECONCILIATION_RACE",
  })
}
