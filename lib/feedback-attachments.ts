import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { del, head, put } from "@vercel/blob"
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client"

import {
  FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  FEEDBACK_ATTACHMENT_MAX_FILE_BYTES,
} from "@/lib/feedback-attachment-rules"

// Re-exported so existing server-side importers keep one import site; the
// values themselves live in the client-safe rules module.
export {
  FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  FEEDBACK_ATTACHMENT_MAX_FILE_BYTES,
}
export const MCP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES = 3 * 1024 * 1024

const allowedMimeTypes = new Set<string>(FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES)
const DIRECT_UPLOAD_TTL_MS = 10 * 60 * 1000
const MAX_INLINE_ENCODED_CHARACTERS = Math.ceil(MCP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES / 3) * 4 + 1024

export type InlineFeedbackAttachment = {
  filename: string
  data: string
  fileType?: string
}

export type FeedbackAttachmentMetadata = {
  url: string
  filename: string
  fileType: string
  fileSize: number
}

type PreparedInlineAttachment = Omit<FeedbackAttachmentMetadata, "url"> & {
  bytes: Buffer
}

type UploadReceiptPayload = {
  version: 1
  attachmentId: string
  workspaceId: string
  pathname: string
  filename: string
  fileType: string
  fileSize: number
  expiresAt: number
}

export function sanitizeFeedbackAttachmentFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_")
}

export function validateFeedbackAttachmentMetadata(
  value: unknown,
): value is FeedbackAttachmentMetadata {
  if (!value || typeof value !== "object") return false
  const { url, filename, fileType, fileSize } = value as Record<string, unknown>
  if (typeof url !== "string" || typeof filename !== "string" || typeof fileType !== "string") return false
  if (!filename || filename.length > 255 || !allowedMimeTypes.has(fileType)) return false
  if (typeof fileSize !== "number" || !Number.isInteger(fileSize) || fileSize < 1 || fileSize > FEEDBACK_ATTACHMENT_MAX_FILE_BYTES) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".public.blob.vercel-storage.com")
  } catch {
    return false
  }
}

function parseBase64(data: string, explicitFileType?: string): { base64: string; fileType: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data)
  const fileType = match?.[1] ?? explicitFileType
  const base64 = match?.[2] ?? data
  if (!fileType) throw new Error("fileType is required when data is raw base64.")
  if (!allowedMimeTypes.has(fileType)) throw new Error(`Unsupported attachment type: ${fileType}`)
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Attachment data must be valid base64 or a base64 data URL.")
  if (base64.includes("=") && !/=+$/.test(base64)) throw new Error("Attachment data must be valid base64 or a base64 data URL.")
  return { base64, fileType }
}

export function decodeInlineFeedbackAttachments(
  attachments: InlineFeedbackAttachment[],
): PreparedInlineAttachment[] {
  if (attachments.length < 1 || attachments.length > FEEDBACK_ATTACHMENT_MAX_COUNT) {
    throw new Error(`Provide between 1 and ${FEEDBACK_ATTACHMENT_MAX_COUNT} attachments.`)
  }
  const encodedCharacters = attachments.reduce((sum, attachment) => sum + attachment.data.length, 0)
  if (encodedCharacters > MAX_INLINE_ENCODED_CHARACTERS) {
    throw new Error("Inline attachments exceed the 3 MiB decoded total limit.")
  }

  let decodedTotal = 0
  const validated = attachments.map((attachment) => {
    if (!attachment.filename || attachment.filename.length > 255) {
      throw new Error("Attachment filenames must be between 1 and 255 characters.")
    }
    const { base64, fileType } = parseBase64(attachment.data, attachment.fileType)
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
    const estimatedBytes = Math.floor((base64.length * 3) / 4) - padding
    decodedTotal += estimatedBytes
    if (decodedTotal > MCP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error("Inline attachments exceed the 3 MiB decoded total limit.")
    }
    return { attachment, base64, fileType, estimatedBytes }
  })

  return validated.map(({ attachment, base64, fileType, estimatedBytes }) => {
    const bytes = Buffer.from(base64, "base64")
    if (bytes.length < 1 || bytes.length !== estimatedBytes) {
      throw new Error("Attachment data must be valid base64 or a base64 data URL.")
    }
    return {
      filename: attachment.filename,
      fileType,
      fileSize: bytes.length,
      bytes,
    }
  })
}

export async function deleteFeedbackBlobs(urls: string[]): Promise<void> {
  if (!urls.length) return
  try {
    await del(urls)
  } catch {
    // Cleanup is best-effort; the original upload/database failure is the useful error.
  }
}

export async function uploadInlineFeedbackAttachments(
  workspaceId: string,
  attachments: InlineFeedbackAttachment[],
): Promise<FeedbackAttachmentMetadata[]> {
  const prepared = decodeInlineFeedbackAttachments(attachments)
  const uploaded: FeedbackAttachmentMetadata[] = []
  try {
    for (const attachment of prepared) {
      const safeName = sanitizeFeedbackAttachmentFilename(attachment.filename)
      const blob = await put(
        `feedback/${workspaceId}/${randomUUID()}-${safeName}`,
        attachment.bytes,
        { access: "public", contentType: attachment.fileType, addRandomSuffix: false },
      )
      uploaded.push({
        url: blob.url,
        filename: attachment.filename,
        fileType: attachment.fileType,
        fileSize: attachment.fileSize,
      })
    }
    return uploaded
  } catch (error) {
    await deleteFeedbackBlobs(uploaded.map((attachment) => attachment.url))
    throw error
  }
}

function receiptSecret(): string {
  const secret = process.env.FEEDBACK_UPLOAD_RECEIPT_SECRET ?? process.env.BLOB_READ_WRITE_TOKEN
  if (!secret) throw new Error("Feedback direct uploads are not configured.")
  return secret
}

/**
 * Exported for lib/embed-screenshots.ts, which validates a widget-submitted
 * screenshot URL against this same exact hostname rather than a generic
 * `.public.blob.vercel-storage.com` suffix — see the note on
 * `isEmbedScreenshotUrl` for why a suffix match there was too permissive: it
 * proves a URL is hosted on *some* Vercel Blob public store, not this one.
 */
export function configuredBlobStoreHostname(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  const storeId = token?.split("_")[3]
  if (!storeId || !/^[a-zA-Z0-9-]+$/.test(storeId)) {
    throw new Error("Feedback direct uploads are not configured with a valid Blob store.")
  }
  return `${storeId.toLowerCase()}.public.blob.vercel-storage.com`
}

function signReceiptPayload(encodedPayload: string): string {
  return createHmac("sha256", receiptSecret()).update(encodedPayload).digest("base64url")
}

export function createFeedbackUploadReceipt(payload: UploadReceiptPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${signReceiptPayload(encoded)}`
}

export type VerifyUploadReceiptOptions = {
  /**
   * How long after the receipt's `expiresAt` it is still accepted, in ms.
   * Defaults to 0 (the MCP contract). The expiry exists to bound the window in
   * which the *client token* can be used to upload; the receipt itself stays
   * HMAC-bound to one workspace, pathname, type and size, and the finished blob
   * is re-checked with `head()`. A human composing feedback can easily spend
   * longer than the 10-minute token window writing after attaching a file, so
   * the in-app composer accepts receipts for a bounded period after expiry.
   */
  graceMs?: number
}

export function verifyFeedbackUploadReceipt(
  receipt: string,
  { graceMs = 0 }: VerifyUploadReceiptOptions = {},
): UploadReceiptPayload {
  const [encoded, signature, extra] = receipt.split(".")
  if (!encoded || !signature || extra) throw new Error("Invalid upload receipt.")
  const expected = Buffer.from(signReceiptPayload(encoded))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid upload receipt.")
  }
  let payload: UploadReceiptPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as UploadReceiptPayload
  } catch {
    throw new Error("Invalid upload receipt.")
  }
  if (
    payload.version !== 1 ||
    typeof payload.attachmentId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.pathname !== "string" ||
    typeof payload.filename !== "string" ||
    typeof payload.fileType !== "string" ||
    typeof payload.fileSize !== "number" ||
    typeof payload.expiresAt !== "number" ||
    payload.expiresAt + Math.max(0, graceMs) < Date.now()
  ) {
    throw new Error("Upload receipt has expired or is invalid.")
  }
  return payload
}

export async function prepareFeedbackAttachmentUpload(input: {
  workspaceId: string
  filename: string
  fileType: string
  fileSize: number
}) {
  const metadata = { ...input, url: "https://placeholder.public.blob.vercel-storage.com/file" }
  if (!validateFeedbackAttachmentMetadata(metadata)) throw new Error("Invalid attachment metadata.")
  const pathname = `feedback/${input.workspaceId}/${randomUUID()}-${sanitizeFeedbackAttachmentFilename(input.filename)}`
  const attachmentId = randomUUID()
  const expiresAt = Date.now() + DIRECT_UPLOAD_TTL_MS
  const clientToken = await generateClientTokenFromReadWriteToken({
    pathname,
    allowedContentTypes: [input.fileType],
    maximumSizeInBytes: input.fileSize,
    validUntil: expiresAt,
    addRandomSuffix: false,
    allowOverwrite: false,
  })
  const receipt = createFeedbackUploadReceipt({ version: 1, attachmentId, ...input, pathname, expiresAt })
  return { clientToken, receipt, pathname, expiresAt, attachmentId }
}

/**
 * Checks — without touching Blob — that `url` is the upload a receipt was
 * issued for, in this workspace's configured store. Used before deleting a
 * blob on the user's behalf, so a caller can only ever delete a pathname the
 * server itself minted for their workspace.
 */
export function verifyFeedbackUploadOwnership(
  input: { workspaceId: string; url: string; receipt: string },
  options: VerifyUploadReceiptOptions = {},
): UploadReceiptPayload {
  const payload = verifyFeedbackUploadReceipt(input.receipt, options)
  if (payload.workspaceId !== input.workspaceId) throw new Error("Upload receipt does not belong to this workspace.")
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    throw new Error("Upload URL is invalid.")
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== configuredBlobStoreHostname() ||
    decodeURIComponent(parsed.pathname) !== `/${payload.pathname}`
  ) {
    throw new Error("Upload URL does not match its receipt.")
  }
  return payload
}

export async function verifyCompletedFeedbackUpload(
  input: {
    workspaceId: string
    url: string
    receipt: string
  },
  options: VerifyUploadReceiptOptions = {},
): Promise<FeedbackAttachmentMetadata & { attachmentId: string }> {
  const payload = verifyFeedbackUploadReceipt(input.receipt, options)
  if (payload.workspaceId !== input.workspaceId) throw new Error("Upload receipt does not belong to this workspace.")
  let uploadedUrl: URL
  try {
    uploadedUrl = new URL(input.url)
  } catch {
    throw new Error("Completed upload URL is invalid.")
  }
  if (uploadedUrl.protocol !== "https:" || uploadedUrl.hostname !== configuredBlobStoreHostname()) {
    throw new Error("Completed upload URL does not belong to the configured Blob store.")
  }
  const metadata = await head(input.url)
  if (
    metadata.url !== input.url ||
    metadata.pathname !== payload.pathname ||
    metadata.contentType !== payload.fileType ||
    metadata.size !== payload.fileSize
  ) {
    throw new Error("Completed upload does not match its receipt.")
  }
  return {
    attachmentId: payload.attachmentId,
    url: metadata.url,
    filename: payload.filename,
    fileType: payload.fileType,
    fileSize: payload.fileSize,
  }
}
