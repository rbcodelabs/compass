import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const prisma = { workspace: { findUnique: vi.fn() } }
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@vercel/blob", () => ({}))
vi.mock("@vercel/blob/client", () => ({ generateClientTokenFromReadWriteToken: vi.fn(async () => "blob-client-token") }))

import { prepareArtifactUploadTool } from "@/lib/artifact-tool-handlers"
import { prepareDocImageUploadTool } from "@/lib/doc-image-tool-handlers"
import { prepareFeedbackAttachmentUploadTool } from "@/lib/feedback-tool-handlers"

const WS = "11111111-1111-4111-8111-111111111111"
const text = (result: { content: { text: string }[] }) => result.content[0]!.text

beforeEach(() => {
  prisma.workspace.findUnique.mockResolvedValue({ id: WS })
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-only-not-a-real-secret")
  vi.stubEnv("ARTIFACT_UPLOAD_RECEIPT_SECRET", "artifact-receipt-secret-for-tests")
  vi.stubEnv("FEEDBACK_UPLOAD_RECEIPT_SECRET", "feedback-receipt-secret-for-tests")
})
afterEach(() => vi.unstubAllEnvs())

describe("prepare_* tool results", () => {
  describe("on S3", () => {
    beforeEach(() => {
      vi.stubEnv("COMPASS_STORAGE_BACKEND", "s3")
      vi.stubEnv("COMPASS_S3_BUCKET", "compass-test-files")
      vi.stubEnv("COMPASS_S3_REGION", "us-east-1")
    })

    it.each([
      ["prepare_artifact_upload", () => prepareArtifactUploadTool({ workspaceId: WS, filename: "a.html", fileSize: 100 })],
      ["prepare_doc_image_upload", () => prepareDocImageUploadTool({ workspaceId: WS, filename: "a.png", fileType: "image/png", fileSize: 100 })],
      ["prepare_feedback_attachment_upload", () => prepareFeedbackAttachmentUploadTool({ workspaceId: WS, filename: "a.png", fileType: "image/png", fileSize: 100 })],
    ])("%s tells the caller to POST the form, and keeps the Blob-shaped fields", async (_name, run) => {
      const result = await run()
      expect(text(result)).toContain("multipart/form-data POST to upload.url")
      expect(text(result)).not.toContain("@vercel/blob/client")
      const data = result.structuredContent!.data as Record<string, unknown>
      expect(data.clientToken).toBe("")
      expect(data.receipt ?? data.pathname).toBeTruthy()
      expect((data.upload as { method: string; url: string; fields: Record<string, string> }).method).toBe("POST")
    })
  })

  describe("on Blob (default)", () => {
    beforeEach(() => {
      vi.stubEnv("COMPASS_STORAGE_BACKEND", "")
      vi.stubEnv("VERCEL", "1")
      vi.stubEnv("ARTIFACT_BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_token")
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_token")
    })

    it.each([
      ["prepare_artifact_upload", () => prepareArtifactUploadTool({ workspaceId: WS, filename: "a.html", fileSize: 100 })],
      ["prepare_doc_image_upload", () => prepareDocImageUploadTool({ workspaceId: WS, filename: "a.png", fileType: "image/png", fileSize: 100 })],
      ["prepare_feedback_attachment_upload", () => prepareFeedbackAttachmentUploadTool({ workspaceId: WS, filename: "a.png", fileType: "image/png", fileSize: 100 })],
    ])("%s is unchanged: client token, @vercel/blob instructions, no S3 upload object", async (_name, run) => {
      const result = await run()
      expect(text(result)).toContain("@vercel/blob/client")
      const data = result.structuredContent!.data as Record<string, unknown>
      expect(data.clientToken).toBe("blob-client-token")
      expect(data).not.toHaveProperty("upload")
      expect(data).not.toHaveProperty("backend")
    })
  })
})
