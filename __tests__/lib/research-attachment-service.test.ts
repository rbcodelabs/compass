import { describe, expect, it, vi } from "vitest"
import { createParticipantResearchAttachment, ResearchAttachmentError } from "@/lib/research-attachment-service"
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
    artifactBlobCleanup: { upsert: vi.fn() },
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
})
