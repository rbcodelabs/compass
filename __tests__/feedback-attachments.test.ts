import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockPut, mockDelete, mockHead, mockGenerateClientToken } = vi.hoisted(() => ({
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
  mockHead: vi.fn(),
  mockGenerateClientToken: vi.fn(),
}))

vi.mock("@vercel/blob", () => ({
  put: mockPut,
  del: mockDelete,
  head: mockHead,
}))

vi.mock("@vercel/blob/client", () => ({
  generateClientTokenFromReadWriteToken: mockGenerateClientToken,
}))

import * as attachmentModule from "@/lib/feedback-attachments"

const WS_ID = "33333333-3333-3333-3333-333333333333"
const BLOB_URL = "https://test.public.blob.vercel-storage.com/feedback/file.png"

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_secret"
})

describe("inline feedback attachments", () => {
  it("rejects aggregate decoded data above 3 MiB before uploading", async () => {
    const chunk = Buffer.alloc(1_600_000, 1).toString("base64")
    await expect(attachmentModule.uploadInlineFeedbackAttachments(WS_ID, [
      { filename: "one.png", fileType: "image/png", data: chunk },
      { filename: "two.png", fileType: "image/png", data: chunk },
    ])).rejects.toThrow(/3 MiB decoded total limit/)
    expect(mockPut).not.toHaveBeenCalled()
  })

  it("accepts the exact 3 MiB decoded aggregate boundary", () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 1).toString("base64")
    const decoded = attachmentModule.decodeInlineFeedbackAttachments([
      { filename: "boundary.png", fileType: "image/png", data },
    ])
    expect(decoded[0].fileSize).toBe(3 * 1024 * 1024)
  })

  it.each([
    "not base64!",
    "data:image/png;base64,AA=A",
    "data:image/png,AAAA",
  ])("rejects malformed base64 without allocating a decoded Buffer: %s", (data) => {
    const from = vi.spyOn(Buffer, "from")
    expect(() => attachmentModule.decodeInlineFeedbackAttachments([
      { filename: "bad.png", fileType: "image/png", data },
    ])).toThrow(/valid base64|data URL/)
    expect(from).not.toHaveBeenCalled()
    from.mockRestore()
  })

  it("validates all parts before allocating when the second part exceeds the aggregate", () => {
    const first = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64")
    const second = Buffer.alloc(1024 * 1024 + 1, 1).toString("base64")
    const from = vi.spyOn(Buffer, "from")
    expect(() => attachmentModule.decodeInlineFeedbackAttachments([
      { filename: "one.png", fileType: "image/png", data: first },
      { filename: "two.png", fileType: "image/png", data: second },
    ])).toThrow(/3 MiB decoded total limit/)
    expect(from).not.toHaveBeenCalled()
    from.mockRestore()
  })

  it("deletes earlier blobs when a later inline upload fails", async () => {
    mockPut
      .mockResolvedValueOnce({ url: BLOB_URL })
      .mockRejectedValueOnce(new Error("blob unavailable"))

    await expect(attachmentModule.uploadInlineFeedbackAttachments(WS_ID, [
      { filename: "one.png", data: "data:image/png;base64,UE5H" },
      { filename: "two.png", data: "data:image/png;base64,UE5H" },
    ])).rejects.toThrow("blob unavailable")

    expect(mockDelete).toHaveBeenCalledWith([BLOB_URL])
  })
})

describe("direct feedback attachment uploads", () => {
  it("prepares a ten-minute, workspace-scoped upload token and signed receipt", async () => {
    expect(attachmentModule.prepareFeedbackAttachmentUpload).toBeTypeOf("function")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"))
    mockGenerateClientToken.mockResolvedValue("client-token")

    const result = await attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID,
      filename: "screen shot.png",
      fileType: "image/png",
      fileSize: 8 * 1024 * 1024,
    })

    expect(result.clientToken).toBe("client-token")
    expect(result.pathname).toMatch(new RegExp(`^feedback/${WS_ID}/.+-screen_shot\\.png$`))
    expect(result.expiresAt).toBe(Date.now() + 10 * 60 * 1000)
    expect(mockGenerateClientToken).toHaveBeenCalledWith(expect.objectContaining({
      pathname: result.pathname,
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 8 * 1024 * 1024,
      validUntil: result.expiresAt,
      addRandomSuffix: false,
      allowOverwrite: false,
    }))
    expect(result.receipt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(result.attachmentId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("rejects a tampered or cross-workspace upload receipt before reading Blob metadata", async () => {
    expect(attachmentModule.prepareFeedbackAttachmentUpload).toBeTypeOf("function")
    expect(attachmentModule.verifyCompletedFeedbackUpload).toBeTypeOf("function")
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID,
      filename: "screenshot.png",
      fileType: "image/png",
      fileSize: 3,
    })

    await expect(attachmentModule.verifyCompletedFeedbackUpload({
      workspaceId: WS_ID,
      url: BLOB_URL,
      receipt: `${prepared.receipt}x`,
    })).rejects.toThrow(/Invalid upload receipt/)
    await expect(attachmentModule.verifyCompletedFeedbackUpload({
      workspaceId: "44444444-4444-4444-4444-444444444444",
      url: BLOB_URL,
      receipt: prepared.receipt,
    })).rejects.toThrow(/does not belong to this workspace/)
    expect(mockHead).not.toHaveBeenCalled()
  })

  it("rejects a Blob URL from a store other than the configured upload store", async () => {
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID,
      filename: "screenshot.png",
      fileType: "image/png",
      fileSize: 3,
    })

    await expect(attachmentModule.verifyCompletedFeedbackUpload({
      workspaceId: WS_ID,
      url: "https://foreign.public.blob.vercel-storage.com/feedback/file.png",
      receipt: prepared.receipt,
    })).rejects.toThrow(/configured Blob store/)
    expect(mockHead).not.toHaveBeenCalled()
  })

  it("accepts completion only when trusted Blob metadata matches the receipt", async () => {
    expect(attachmentModule.prepareFeedbackAttachmentUpload).toBeTypeOf("function")
    expect(attachmentModule.verifyCompletedFeedbackUpload).toBeTypeOf("function")
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID,
      filename: "screenshot.png",
      fileType: "image/png",
      fileSize: 3,
    })
    mockHead.mockResolvedValue({
      url: BLOB_URL,
      pathname: prepared.pathname,
      contentType: "image/png",
      size: 3,
    })

    await expect(attachmentModule.verifyCompletedFeedbackUpload({
      workspaceId: WS_ID,
      url: BLOB_URL,
      receipt: prepared.receipt,
    })).resolves.toEqual({
      attachmentId: prepared.attachmentId,
      url: BLOB_URL,
      filename: "screenshot.png",
      fileType: "image/png",
      fileSize: 3,
    })
  })

  it.each([
    ["pathname", { pathname: "feedback/other.png", contentType: "image/png", size: 3 }],
    ["content type", { contentType: "image/jpeg", size: 3 }],
    ["size", { contentType: "image/png", size: 4 }],
  ])("rejects a completed upload with mismatched %s", async (_field, override) => {
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID, filename: "screenshot.png", fileType: "image/png", fileSize: 3,
    })
    mockHead.mockResolvedValue({
      url: BLOB_URL,
      pathname: "pathname" in override ? override.pathname : prepared.pathname,
      contentType: override.contentType ?? "image/png",
      size: override.size ?? 3,
    })
    await expect(attachmentModule.verifyCompletedFeedbackUpload({
      workspaceId: WS_ID, url: BLOB_URL, receipt: prepared.receipt,
    })).rejects.toThrow(/does not match/)
  })
})

describe("receipt expiry grace (in-app composer)", () => {
  async function prepareAt(now: number) {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    mockGenerateClientToken.mockResolvedValue("client-token")
    return attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID, filename: "screenshot.png", fileType: "image/png", fileSize: 3,
    })
  }

  it("keeps the MCP default: an expired receipt is rejected", async () => {
    const prepared = await prepareAt(Date.UTC(2026, 0, 1))
    vi.setSystemTime(prepared.expiresAt + 1)
    expect(() => attachmentModule.verifyFeedbackUploadReceipt(prepared.receipt)).toThrow(/expired/)
  })

  it("accepts an expired receipt inside the caller's grace window, and not after it", async () => {
    const prepared = await prepareAt(Date.UTC(2026, 0, 1))
    vi.setSystemTime(prepared.expiresAt + 60_000)
    expect(attachmentModule.verifyFeedbackUploadReceipt(prepared.receipt, { graceMs: 120_000 }).pathname)
      .toBe(prepared.pathname)
    vi.setSystemTime(prepared.expiresAt + 120_001)
    expect(() => attachmentModule.verifyFeedbackUploadReceipt(prepared.receipt, { graceMs: 120_000 }))
      .toThrow(/expired/)
  })
})

describe("verifyFeedbackUploadOwnership", () => {
  async function prepared() {
    mockGenerateClientToken.mockResolvedValue("client-token")
    return attachmentModule.prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID, filename: "screenshot.png", fileType: "image/png", fileSize: 3,
    })
  }

  it("accepts the exact URL the receipt minted, in the configured store", async () => {
    const upload = await prepared()
    const url = `https://test.public.blob.vercel-storage.com/${upload.pathname}`
    expect(attachmentModule.verifyFeedbackUploadOwnership({ workspaceId: WS_ID, url, receipt: upload.receipt }).pathname)
      .toBe(upload.pathname)
    expect(mockHead).not.toHaveBeenCalled()
  })

  it.each([
    ["another pathname", "https://test.public.blob.vercel-storage.com/feedback/someone-else.png"],
    ["another store", "PATH_ON_FOREIGN_STORE"],
    ["plain http", "PATH_OVER_HTTP"],
  ])("rejects %s", async (_label, variant) => {
    const upload = await prepared()
    const url = variant === "PATH_ON_FOREIGN_STORE"
      ? `https://foreign.public.blob.vercel-storage.com/${upload.pathname}`
      : variant === "PATH_OVER_HTTP"
        ? `http://test.public.blob.vercel-storage.com/${upload.pathname}`
        : variant
    expect(() => attachmentModule.verifyFeedbackUploadOwnership({ workspaceId: WS_ID, url, receipt: upload.receipt }))
      .toThrow(/does not match its receipt/)
  })

  it("rejects a receipt minted for a different workspace", async () => {
    const upload = await prepared()
    const url = `https://test.public.blob.vercel-storage.com/${upload.pathname}`
    expect(() => attachmentModule.verifyFeedbackUploadOwnership({
      workspaceId: "44444444-4444-4444-4444-444444444444", url, receipt: upload.receipt,
    })).toThrow(/does not belong to this workspace/)
  })
})
