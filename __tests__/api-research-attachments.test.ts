import { afterEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const createParticipantResearchAttachment = vi.hoisted(() => vi.fn())
const getParticipantResearchAttachment = vi.hoisted(() => vi.fn())
const storage = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("@/lib/research-attachment-service", () => ({
  ResearchAttachmentError: class ResearchAttachmentError extends Error { constructor(message: string, readonly status: number) { super(message) } },
  createParticipantResearchAttachment,
  getParticipantResearchAttachment,
}))
vi.mock("@/lib/artifact-storage", () => ({ getResearchArtifactStorage: () => storage }))

import { POST as upload } from "@/app/api/research/attachments/route"
import { POST as download } from "@/app/api/research/attachments/[attachmentId]/route"

afterEach(() => vi.clearAllMocks())

describe("research attachment APIs", () => {
  it("uploads an authorized file without disclosing private storage provenance", async () => {
    resolveActiveResearchStudy.mockResolvedValue({ study: { id: "study-1" }, prisma: {} })
    createParticipantResearchAttachment.mockResolvedValue({ id: "attachment-1", status: "READY", originalName: "screen.png", mimeType: "image/png", sizeBytes: 9 })
    const form = new FormData()
    form.set("token", "study-token")
    form.set("sessionId", "session-1")
    form.set("resumeToken", "resume-secret")
    form.set("idempotencyKey", "attachment-key-0001")
    form.set("file", new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" }))
    const response = await upload(new Request("http://localhost/api/research/attachments", { method: "POST", body: form }))
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain("blobPathname")
  })

  it("keeps private pathname and storage details out of upload failure responses", async () => {
    resolveActiveResearchStudy.mockResolvedValue({ study: { id: "study-1" }, prisma: {} })
    const { ResearchAttachmentError } = await import("@/lib/research-attachment-service")
    createParticipantResearchAttachment.mockRejectedValue(
      new ResearchAttachmentError("Attachment storage failed", 502),
    )
    const form = new FormData()
    form.set("token", "study-token")
    form.set("sessionId", "session-1")
    form.set("resumeToken", "resume-secret")
    form.set("idempotencyKey", "attachment-key-0001")
    form.set("file", new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" }))

    const response = await upload(new Request("http://localhost/api/research/attachments", { method: "POST", body: form }))
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toEqual({ error: "Attachment storage failed" })
    expect(JSON.stringify(body)).not.toContain("research/workspace-1")
    expect(JSON.stringify(body)).not.toContain("private storage unavailable")
  })

  it("serves private bytes only after participant session authorization", async () => {
    resolveActiveResearchStudy.mockResolvedValue({ study: { id: "study-1" }, prisma: {} })
    getParticipantResearchAttachment.mockResolvedValue({ blobPathname: "private/path", mimeType: "image/png", originalName: "screen.png" })
    storage.get.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const response = await download(new Request("http://localhost/api/research/attachments/attachment-1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "study-token", sessionId: "session-1", resumeToken: "resume-secret" }),
    }), { params: Promise.resolve({ attachmentId: "attachment-1" }) })
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect((await response.arrayBuffer()).byteLength).toBe(3)
  })
})
