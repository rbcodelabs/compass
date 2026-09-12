import { randomUUID } from "node:crypto"
import type { ResearchStudy } from "@prisma/client"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { hashResearchResumeToken, MAX_RESEARCH_TURNS, MAX_RESEARCH_TRANSCRIPT_CHARS } from "@/lib/research-session"
import { ResearchVoiceError } from "@/lib/research-voice"

export const MAX_BROWSER_VOICE_CLAIMS = 5
type Context = { prisma: AppPrismaClient; study: ResearchStudy; participantToken: { id: string } }
type SessionInput = { context: Context; sessionId: string; resumeToken: string }

// Writes fence concurrent revocation/closure under DSQL snapshot isolation.
async function fenceAccess(tx: AppTransactionClient, context: Context, now: Date) {
  const token = await tx.researchParticipantToken.updateMany({
    where: { id: context.participantToken.id, studyId: context.study.id, revokedAt: null, expiresAt: { gt: now } }, data: { lastUsedAt: now },
  })
  const study = await tx.researchStudy.updateMany({
    where: { id: context.study.id, workspaceId: context.study.workspaceId, status: "ACTIVE" }, data: { updatedAt: now },
  })
  if (token.count !== 1 || study.count !== 1) throw new ResearchVoiceError("Voice connection is not authorized", 404)
}

function sessionWhere({ context, sessionId, resumeToken }: SessionInput) {
  return { id: sessionId, studyId: context.study.id, participantTokenId: context.participantToken.id,
    resumeTokenHash: hashResearchResumeToken(resumeToken), modality: "VOICE", status: "IN_PROGRESS" }
}

export async function claimParticipantVoiceLease(input: SessionInput) {
  return input.context.prisma.$transaction(async (tx) => {
    const now = new Date()
    await fenceAccess(tx, input.context, now)
    const session = await tx.researchSession.findFirst({ where: sessionWhere(input), include: { turns: { orderBy: { sequence: "asc" }, take: MAX_RESEARCH_TURNS } } })
    if (!session) throw new ResearchVoiceError("Session not found", 404)
    if (session.voiceLeaseId && session.voiceLeaseExpiresAt && session.voiceLeaseExpiresAt > now) throw new ResearchVoiceError("A voice connection is already active", 409)
    if ((session.voiceAttemptCount ?? 0) >= MAX_BROWSER_VOICE_CLAIMS) throw new ResearchVoiceError("This session has reached its voice reconnect limit. Please use chat or contact the researcher.", 429)
    const participant = await tx.researchParticipantToken.findFirst({ where: { id: input.context.participantToken.id } })
    if (!participant) throw new ResearchVoiceError("Voice connection is not authorized", 404)
    const minuteFresh = !participant.voiceWindowAt || now.getTime() - participant.voiceWindowAt.getTime() >= 60_000
    const dayFresh = !participant.voiceDayAt || now.getTime() - participant.voiceDayAt.getTime() >= 86_400_000
    const minuteCount = minuteFresh ? 0 : participant.voiceCount ?? 0
    const dayCount = dayFresh ? 0 : participant.voiceDayCount ?? 0
    if (minuteCount >= 5) throw new ResearchVoiceError("Please wait a minute before reconnecting voice", 429)
    if (dayCount >= 20) throw new ResearchVoiceError("This participant link has reached its daily voice connection limit", 429)
    const charged = await tx.researchParticipantToken.updateMany({
      where: { id: participant.id, revokedAt: null, expiresAt: { gt: now }, voiceCount: participant.voiceCount, voiceDayCount: participant.voiceDayCount, voiceWindowAt: participant.voiceWindowAt, voiceDayAt: participant.voiceDayAt },
      data: { voiceCount: minuteCount + 1, voiceDayCount: dayCount + 1, voiceWindowAt: minuteFresh ? now : participant.voiceWindowAt, voiceDayAt: dayFresh ? now : participant.voiceDayAt, lastUsedAt: now },
    })
    if (charged.count !== 1) throw new ResearchVoiceError("Voice connection changed concurrently", 409)
    const leaseId = randomUUID()
    const expiresAt = new Date(now.getTime() + (input.context.study.targetMinutes + 5) * 60_000)
    const updated = await tx.researchSession.updateMany({
      where: { ...sessionWhere(input), voiceLeaseId: session.voiceLeaseId, voiceLeaseExpiresAt: session.voiceLeaseExpiresAt, voiceAttemptCount: session.voiceAttemptCount },
      data: { voiceLeaseId: leaseId, voiceLeaseExpiresAt: expiresAt, voiceAttemptCount: (session.voiceAttemptCount ?? 0) + 1, lastActiveAt: now, updatedAt: now },
    })
    if (updated.count !== 1) throw new ResearchVoiceError("Voice connection changed concurrently", 409)
    return { leaseId, expiresAt, turns: session.turns }
  })
}

export async function verifyParticipantVoiceLease(input: SessionInput & { leaseId: string }) {
  return input.context.prisma.$transaction(async (tx) => {
    const now = new Date()
    await fenceAccess(tx, input.context, now)
    const session = await tx.researchSession.findFirst({ where: { ...sessionWhere(input), voiceLeaseId: input.leaseId, voiceLeaseExpiresAt: { gt: now } }, select: { id: true } })
    if (!session) throw new ResearchVoiceError("Voice connection is not authorized", 404)
  })
}

export async function releaseParticipantVoiceLease(input: SessionInput & { leaseId: string }) {
  // Resume-secret authorization remains usable for cleanup after link revocation.
  // This releases only Compass's lease, never attests provider termination.
  return input.context.prisma.$transaction(async (tx) => {
    const session = await tx.researchSession.findFirst({ where: sessionWhere(input) })
    if (!session) throw new ResearchVoiceError("Voice connection is not authorized", 404)
    if (session.voiceLeaseId === null) return { released: true }
    if (session.voiceLeaseId !== input.leaseId) throw new ResearchVoiceError("A different voice connection is active", 409)
    const now = new Date()
    const updated = await tx.researchSession.updateMany({ where: { ...sessionWhere(input), voiceLeaseId: input.leaseId }, data: { voiceLeaseId: null, voiceLeaseExpiresAt: null, lastActiveAt: now, updatedAt: now } })
    if (updated.count !== 1) throw new ResearchVoiceError("Voice connection changed concurrently", 409)
    return { released: true }
  })
}

export async function appendParticipantVoiceEvent(input: SessionInput & {
  leaseId: string; clientEventId: string; reportedOrdinal: number;
  role: "PARTICIPANT" | "INTERVIEWER"; content: string; attachmentId?: string;
}) {
  const { context, sessionId, leaseId, clientEventId, reportedOrdinal, role, attachmentId } = input
  const content = input.content.trim()
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(clientEventId) || !Number.isSafeInteger(reportedOrdinal) || reportedOrdinal < 0 || reportedOrdinal >= MAX_RESEARCH_TURNS || !["PARTICIPANT", "INTERVIEWER"].includes(role) || !content || content.length > 4_000 || (attachmentId && role !== "PARTICIPANT")) throw new ResearchVoiceError("Invalid participant voice event", 400)
  return context.prisma.$transaction(async (tx) => {
    const now = new Date()
    await fenceAccess(tx, context, now)
    const session = await tx.researchSession.findFirst({ where: { ...sessionWhere(input), voiceLeaseId: leaseId, voiceLeaseExpiresAt: { gt: now } } })
    if (!session) throw new ResearchVoiceError("Voice connection is not authorized", 404)
    const prior = await tx.researchParticipantVoiceEvent.findUnique({ where: { sessionId_clientEventId: { sessionId, clientEventId } } })
    if (prior) {
      if (prior.workspaceId !== context.study.workspaceId || prior.leaseId !== leaseId || prior.reportedOrdinal !== reportedOrdinal || prior.claimedSpeaker !== role || prior.content !== content) throw new ResearchVoiceError("Client event ID was reused with different content", 409)
      const attachments = await tx.researchAttachment.findMany({ where: { turnId: prior.turnId, sessionId, studyId: context.study.id, workspaceId: context.study.workspaceId }, select: { id: true } })
      if (attachments.length !== (attachmentId ? 1 : 0) || (attachmentId && attachments[0]?.id !== attachmentId)) throw new ResearchVoiceError("Client event ID was reused with a different attachment", 409)
      return { replayed: true, source: "PARTICIPANT_SUBMITTED", turn: await tx.researchTurn.findUnique({ where: { id: prior.turnId } }) }
    }
    const last = await tx.researchParticipantVoiceEvent.findFirst({ where: { sessionId, leaseId }, orderBy: { reportedOrdinal: "desc" } })
    if (reportedOrdinal !== (last ? last.reportedOrdinal + 1 : 0)) throw new ResearchVoiceError("Voice transcript order does not match the next expected event", 409)
    const recent = await tx.researchParticipantVoiceEvent.count({ where: { sessionId, createdAt: { gte: new Date(now.getTime() - 60_000) } } })
    if (recent >= 30) throw new ResearchVoiceError("Please wait before saving more voice events", 429)
    if ((session.voiceTurnCount ?? 0) >= MAX_RESEARCH_TURNS || (session.voiceTranscriptChars ?? 0) + content.length > MAX_RESEARCH_TRANSCRIPT_CHARS) throw new ResearchVoiceError("This interview has reached its transcript limit", 409)
    const sequence = session.nextSequence ?? 0
    const updated = await tx.researchSession.updateMany({
      where: { ...sessionWhere(input), voiceLeaseId: leaseId, voiceLeaseExpiresAt: { gt: now }, nextSequence: session.nextSequence },
      data: { nextSequence: sequence + 1, voiceTurnCount: (session.voiceTurnCount ?? 0) + 1, voiceTranscriptChars: (session.voiceTranscriptChars ?? 0) + content.length, lastActiveAt: now, updatedAt: now },
    })
    if (updated.count !== 1) throw new ResearchVoiceError("Voice transcript changed concurrently", 409)
    const turn = await tx.researchTurn.create({ data: { id: randomUUID(), sessionId, role, content, sequence } })
    if (attachmentId) {
      const linked = await tx.researchAttachment.updateMany({ where: { id: attachmentId, workspaceId: context.study.workspaceId, studyId: context.study.id, sessionId, status: "READY", turnId: null }, data: { turnId: turn.id } })
      if (linked.count !== 1) throw new ResearchVoiceError("Attachment is not available", 409)
    }
    await tx.researchParticipantVoiceEvent.create({ data: { workspaceId: context.study.workspaceId, sessionId, leaseId, clientEventId, reportedOrdinal, claimedSpeaker: role, content, turnId: turn.id } })
    return { replayed: false, source: "PARTICIPANT_SUBMITTED", turn }
  })
}
