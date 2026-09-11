import { randomUUID } from "node:crypto"
import type { PrismaClient, ResearchStudy } from "@prisma/client"
import type { ArtifactStorage } from "@/lib/artifact-storage"
import {
  buildResearchAttachmentPathname,
  MAX_RESEARCH_ATTACHMENTS_PER_SESSION,
  MAX_RESEARCH_ATTACHMENT_BYTES_PER_SESSION,
  validateResearchAttachmentUpload,
} from "@/lib/research-attachments"
import { hashResearchResumeToken } from "@/lib/research-session"

const MAX_ATTACHMENTS_PER_MINUTE = 5
const RESEARCH_CLEANUP_RETRY_LIMIT = 5
const RESEARCH_CLEANUP_RETRY_DELAY_MS = 60_000

type AttachmentContext = {
  prisma: PrismaClient
  study: ResearchStudy
  participantToken: { id: string }
}

export class ResearchAttachmentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "ResearchAttachmentError"
  }
}

function publicAttachment(attachment: {
  id: string
  status: string
  originalName: string
  mimeType: string
  sizeBytes: number
  kind?: string
}) {
  return {
    id: attachment.id,
    status: attachment.status,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.kind ? { kind: attachment.kind } : {}),
  }
}

async function authorizeSession(
  context: AttachmentContext,
  sessionId: string,
  resumeToken: string,
) {
  const session = await context.prisma.researchSession.findFirst({
    where: {
      id: sessionId,
      studyId: context.study.id,
      participantTokenId: context.participantToken.id,
      resumeTokenHash: hashResearchResumeToken(resumeToken),
      status: "IN_PROGRESS",
    },
    select: { id: true, status: true },
  })
  if (!session) throw new ResearchAttachmentError("Session not found", 404)
  return session
}

function ownsResearchBlobPath(cleanup: {
  workspaceId: string
  studyId: string
  sessionId: string
  attachmentId: string
  blobPathname: string
}) {
  const prefix = [
    "research",
    cleanup.workspaceId,
    cleanup.studyId,
    cleanup.sessionId,
    `${cleanup.attachmentId}-`,
  ].join("/")
  const suffix = cleanup.blobPathname.slice(prefix.length)
  return cleanup.blobPathname.startsWith(prefix) && /^[a-f0-9]{32}\.(?:png|jpg|webp|gif|heic|pdf)$/.test(suffix)
}

export async function retryResearchBlobCleanups({
  context,
  storage,
  limit = RESEARCH_CLEANUP_RETRY_LIMIT,
}: {
  context: AttachmentContext
  storage: ArtifactStorage
  limit?: number
}) {
  const now = new Date()
  const rows = await context.prisma.researchBlobCleanup.findMany({
    where: {
      workspaceId: context.study.workspaceId,
      status: "PENDING",
      nextAttemptAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), RESEARCH_CLEANUP_RETRY_LIMIT),
  })

  for (const row of rows) {
    if (!ownsResearchBlobPath(row)) {
      await context.prisma.researchBlobCleanup.update({
        where: { id: row.id },
        data: { status: "REJECTED", attempts: row.attempts + 1, updatedAt: new Date() },
      })
      continue
    }
    try {
      await storage.del(row.blobPathname)
      const completedAt = new Date()
      await context.prisma.researchBlobCleanup.update({
        where: { id: row.id },
        data: { status: "COMPLETED", completedAt, updatedAt: completedAt },
      })
    } catch {
      const attempts = row.attempts + 1
      await context.prisma.researchBlobCleanup.update({
        where: { id: row.id },
        data: {
          attempts,
          nextAttemptAt: new Date(Date.now() + RESEARCH_CLEANUP_RETRY_DELAY_MS * Math.min(attempts, 60)),
          updatedAt: new Date(),
        },
      })
    }
  }
}

export async function createParticipantResearchAttachment({
  context,
  storage,
  sessionId,
  resumeToken,
  idempotencyKey,
  originalName,
  mimeType,
  bytes,
}: {
  context: AttachmentContext
  storage: ArtifactStorage
  sessionId: string
  resumeToken: string
  idempotencyKey: string
  originalName: string
  mimeType: string
  bytes: Uint8Array
}) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new ResearchAttachmentError("A valid idempotency key is required", 400)
  }
  await authorizeSession(context, sessionId, resumeToken)
  await retryResearchBlobCleanups({ context, storage }).catch(() => undefined)
  let validated: ReturnType<typeof validateResearchAttachmentUpload>
  try {
    validated = validateResearchAttachmentUpload({ bytes, mimeType, originalName })
  } catch (error) {
    throw new ResearchAttachmentError(error instanceof Error ? error.message : "Invalid attachment", 400)
  }
  const existing = await context.prisma.researchAttachment.findUnique({
    where: { sessionId_idempotencyKey: { sessionId, idempotencyKey } },
  })
  if (existing) {
    if (
      existing.sha256 !== validated.sha256 || existing.sizeBytes !== validated.sizeBytes ||
      existing.mimeType !== validated.mimeType || existing.originalName !== validated.originalName
    ) throw new ResearchAttachmentError("Idempotency key was used for a different attachment", 409)
    if (existing.status !== "READY") throw new ResearchAttachmentError("Attachment is not ready", 409)
    return { ...publicAttachment(existing), replayed: true }
  }
  const attachments = await context.prisma.researchAttachment.findMany({
    where: { sessionId, status: { in: ["PENDING", "READY"] } },
    select: { sizeBytes: true },
    take: MAX_RESEARCH_ATTACHMENTS_PER_SESSION + 1,
  })
  if (attachments.length >= MAX_RESEARCH_ATTACHMENTS_PER_SESSION) {
    throw new ResearchAttachmentError("This session has reached its attachment limit", 429)
  }
  if (attachments.reduce((sum, item) => sum + item.sizeBytes, 0) + validated.sizeBytes > MAX_RESEARCH_ATTACHMENT_BYTES_PER_SESSION) {
    throw new ResearchAttachmentError("This session has reached its attachment storage limit", 413)
  }
  const recentCount = await context.prisma.researchAttachment.count({
    where: { sessionId, createdAt: { gte: new Date(Date.now() - 60_000) } },
  })
  if (recentCount >= MAX_ATTACHMENTS_PER_MINUTE) {
    throw new ResearchAttachmentError("Please wait before uploading another attachment", 429)
  }
  const attachmentId = randomUUID()
  const blobPathname = buildResearchAttachmentPathname({
    workspaceId: context.study.workspaceId,
    studyId: context.study.id,
    sessionId,
    attachmentId,
    extension: validated.extension,
  })
  const pending = await context.prisma.researchAttachment.create({
    data: {
      id: attachmentId,
      workspaceId: context.study.workspaceId,
      studyId: context.study.id,
      sessionId,
      kind: validated.kind,
      status: "PENDING",
      blobPathname,
      originalName: validated.originalName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      sha256: validated.sha256,
      idempotencyKey,
    },
  })
  try {
    const stored = await storage.put(blobPathname, bytes, validated.mimeType)
    if (stored.pathname !== blobPathname) throw new Error("Private storage changed the attachment pathname")
    const readyAt = new Date()
    const ready = await context.prisma.researchAttachment.update({
      where: { id: pending.id },
      data: { status: "READY", readyAt },
    })
    return { ...publicAttachment({ ...pending, ...ready }), replayed: false }
  } catch {
    await context.prisma.researchAttachment.update({
      where: { id: pending.id },
      data: { status: "REJECTED" },
    }).catch(() => undefined)
    try {
      await storage.del(blobPathname)
    } catch {
      await context.prisma.researchBlobCleanup.upsert({
        where: { blobPathname },
        create: {
          workspaceId: context.study.workspaceId,
          studyId: context.study.id,
          sessionId,
          attachmentId: pending.id,
          blobPathname,
          status: "PENDING",
        },
        update: {
          status: "PENDING",
          nextAttemptAt: new Date(),
          completedAt: null,
          updatedAt: new Date(),
        },
      })
    }
    throw new ResearchAttachmentError("Attachment storage failed", 502)
  }
}

export async function getParticipantResearchAttachment({
  context,
  sessionId,
  resumeToken,
  attachmentId,
}: {
  context: AttachmentContext
  sessionId: string
  resumeToken: string
  attachmentId: string
}) {
  await authorizeSession(context, sessionId, resumeToken)
  const attachment = await context.prisma.researchAttachment.findFirst({
    where: {
      id: attachmentId,
      workspaceId: context.study.workspaceId,
      studyId: context.study.id,
      sessionId,
      status: "READY",
      deletedAt: null,
    },
  })
  if (!attachment) throw new ResearchAttachmentError("Attachment not found", 404)
  return attachment
}
