import { describe, expect, it, vi } from "vitest"
import {
  createParticipantResearchAttachment,
  ResearchAttachmentError,
  retryResearchBlobCleanups,
} from "@/lib/research-attachment-service"
import { hashResearchResumeToken } from "@/lib/research-session"
import { validateResearchAttachmentUpload } from "@/lib/research-attachments"

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

function fixture() {
  const prisma = {
    researchSession: { findFirst: vi.fn().mockResolvedValue({ id: "session-1", status: "IN_PROGRESS" }) },
    researchAttachment: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, createdAt: new Date() })),
      update: vi.fn().mockImplementation(async ({ data }) => data),
    },
    researchBlobCleanup: {
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
  }
  const storage = { put: vi.fn().mockImplementation(async (pathname: string) => ({ pathname })), get: vi.fn(), del: vi.fn() }
  const context = {
    prisma,
    study: { id: "study-1", workspaceId: "workspace-1", studyType: "USABILITY_TEST" },
    participantToken: { id: "token-1" },
  }
  return { prisma, storage, context }
}

describe("participant research attachment persistence", () => {
  it("authorizes the active participant session, writes private bytes, and returns no pathname", async () => {
    const { prisma, storage, context } = fixture()
    const result = await createParticipantResearchAttachment({
      context: context as never, storage, sessionId: "session-1", resumeToken: "resume-secret",
      idempotencyKey: "attachment-key-0001", originalName: "screen.png", mimeType: "image/png", bytes,
    })
    expect(prisma.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: "session-1", studyId: "study-1", participantTokenId: "token-1", resumeTokenHash: hashResearchResumeToken("resume-secret"),
    }) }))
    expect(storage.put).toHaveBeenCalledWith(expect.stringMatching(/^research\/workspace-1\/study-1\/session-1\//), bytes, "image/png")
    expect(result).toMatchObject({ id: expect.any(String), status: "READY", originalName: "screen.png", mimeType: "image/png" })
    expect(result).not.toHaveProperty("blobPathname")
  })

  it("replays the same idempotent upload without writing another blob", async () => {
    const { prisma, storage, context } = fixture()
    prisma.researchAttachment.findUnique.mockResolvedValue({
      id: "attachment-1", status: "READY", originalName: "screen.png", mimeType: "image/png",
      sizeBytes: bytes.length, sha256: validateResearchAttachmentUpload({ bytes, mimeType: "image/png", originalName: "screen.png" }).sha256,
    })
    const result = await createParticipantResearchAttachment({
      context: context as never, storage, sessionId: "session-1", resumeToken: "resume-secret",
      idempotencyKey: "attachment-key-0001", originalName: "screen.png", mimeType: "image/png", bytes,
    })
    expect(result).toMatchObject({ id: "attachment-1", replayed: true })
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("enforces per-session count and total-byte quotas before storage", async () => {
    const { prisma, storage, context } = fixture()
    prisma.researchAttachment.findMany.mockResolvedValue(Array.from({ length: 20 }, () => ({ sizeBytes: 1 })))
    await expect(createParticipantResearchAttachment({
      context: context as never, storage, sessionId: "session-1", resumeToken: "resume-secret",
      idempotencyKey: "attachment-key-0001", originalName: "screen.png", mimeType: "image/png", bytes,
    })).rejects.toMatchObject({ status: 429 } satisfies Partial<ResearchAttachmentError>)
    expect(storage.put).not.toHaveBeenCalled()
  })

  it("records failed blob compensation in the research-owned cleanup queue", async () => {
    const { prisma, storage, context } = fixture()
    storage.put.mockRejectedValue(new Error("private storage unavailable"))
    storage.del.mockRejectedValue(new Error("delete unavailable"))

    await expect(createParticipantResearchAttachment({
      context: context as never, storage, sessionId: "session-1", resumeToken: "resume-secret",
      idempotencyKey: "attachment-key-0001", originalName: "screen.png", mimeType: "image/png", bytes,
    })).rejects.toMatchObject({
      message: "Attachment storage failed",
      status: 502,
    } satisfies Partial<ResearchAttachmentError>)

    expect(prisma.researchBlobCleanup.upsert).toHaveBeenCalledWith({
      where: { blobPathname: expect.stringMatching(/^research\/workspace-1\/study-1\/session-1\//) },
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        studyId: "study-1",
        sessionId: "session-1",
        attachmentId: expect.any(String),
        blobPathname: expect.stringMatching(/^research\/workspace-1\/study-1\/session-1\//),
        status: "PENDING",
      }),
      update: expect.objectContaining({ status: "PENDING" }),
    })
    expect(context.prisma).not.toHaveProperty("artifactBlobCleanup")
  })

  it("retries only tenant-owned research paths and completes successful cleanup", async () => {
    const { prisma, storage, context } = fixture()
    prisma.researchBlobCleanup.findMany.mockResolvedValue([{
      id: "cleanup-1",
      workspaceId: "workspace-1",
      studyId: "study-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      blobPathname: "research/workspace-1/study-1/session-1/attachment-1-0123456789abcdef0123456789abcdef.png",
      attempts: 1,
    }])

    await retryResearchBlobCleanups({ context: context as never, storage })

    expect(prisma.researchBlobCleanup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "workspace-1", status: "PENDING" }),
      take: 5,
    }))
    expect(storage.del).toHaveBeenCalledWith(
      "research/workspace-1/study-1/session-1/attachment-1-0123456789abcdef0123456789abcdef.png",
    )
    expect(prisma.researchBlobCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({ status: "COMPLETED", completedAt: expect.any(Date) }),
    })
  })

  it("rejects a queued pathname that does not match its tenant provenance", async () => {
    const { prisma, storage, context } = fixture()
    prisma.researchBlobCleanup.findMany.mockResolvedValue([{
      id: "cleanup-1",
      workspaceId: "workspace-1",
      studyId: "study-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      blobPathname: "research/workspace-2/study-1/session-1/attachment-1-0123456789abcdef0123456789abcdef.png",
      attempts: 0,
    }])

    await retryResearchBlobCleanups({ context: context as never, storage })

    expect(storage.del).not.toHaveBeenCalled()
    expect(prisma.researchBlobCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({ status: "REJECTED", attempts: 1 }),
    })
  })

  it("keeps failed cleanup durable and schedules another retry", async () => {
    const { prisma, storage, context } = fixture()
    prisma.researchBlobCleanup.findMany.mockResolvedValue([{
      id: "cleanup-1",
      workspaceId: "workspace-1",
      studyId: "study-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      blobPathname: "research/workspace-1/study-1/session-1/attachment-1-0123456789abcdef0123456789abcdef.png",
      attempts: 2,
    }])
    storage.del.mockRejectedValue(new Error("delete still unavailable"))

    await retryResearchBlobCleanups({ context: context as never, storage })

    expect(prisma.researchBlobCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: expect.objectContaining({
        attempts: 3,
        nextAttemptAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    })
  })
})
