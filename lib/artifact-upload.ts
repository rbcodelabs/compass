import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client"
import type { ArtifactStorage } from "@/lib/artifact-storage"
import { MAX_ARTIFACT_HTML_BYTES } from "@/lib/artifacts"

/**
 * Direct-upload path for HTML artifacts.
 *
 * Inline `html` on create_artifact/update_artifact forces the whole document
 * through the agent's context twice (once to write it, once in the tool call).
 * This flow keeps the bytes out of the conversation: the agent asks for a
 * signed target, uploads the file from disk, then passes only a small receipt.
 *
 * The staged blob is private, workspace-prefixed, and deleted when consumed, so
 * a receipt is effectively single-use. Final validation (UTF-8, doctype, size)
 * is NOT done at prepare time -- the server re-reads the bytes and runs the
 * same validateHtmlUpload gate as the inline path.
 */

const DIRECT_UPLOAD_TTL_MS = 10 * 60 * 1000
const STAGING_PREFIX = "artifact-staging"

type ArtifactUploadReceiptPayload = {
  version: 1
  uploadId: string
  workspaceId: string
  pathname: string
  filename: string
  fileSize: number
  expiresAt: number
}

function receiptSecret(): string {
  const secret = process.env.ARTIFACT_UPLOAD_RECEIPT_SECRET?.trim() || process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim()
  if (!secret) throw new Error("Artifact direct uploads are not configured")
  return secret
}

/** Domain-separated so a feedback/other receipt can never validate here. */
function sign(encodedPayload: string): string {
  return createHmac("sha256", receiptSecret()).update(`artifact-upload:v1:${encodedPayload}`).digest("base64url")
}

function stagingPathname(workspaceId: string, uploadId: string): string {
  return `${STAGING_PREFIX}/${workspaceId}/${uploadId}.html`
}

export function validateArtifactUploadRequest(input: { filename: string; fileSize: number }): void {
  const { filename, fileSize } = input
  if (!filename || filename.includes("/") || filename.includes("\\") || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw new Error("Artifact filename must be a safe single filename")
  }
  if (!filename.toLowerCase().endsWith(".html")) throw new Error("Artifact filename must end in .html")
  if (!Number.isInteger(fileSize) || fileSize < 1) throw new Error("HTML file is empty")
  if (fileSize > MAX_ARTIFACT_HTML_BYTES) throw new Error("HTML file exceeds the 2 MB size limit")
}

export async function prepareArtifactUpload(input: { workspaceId: string; filename: string; fileSize: number }, now = Date.now()) {
  validateArtifactUploadRequest(input)
  const token = process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Private artifact storage is not configured")
  const uploadId = randomUUID()
  const pathname = stagingPathname(input.workspaceId, uploadId)
  const expiresAt = now + DIRECT_UPLOAD_TTL_MS
  const clientToken = await generateClientTokenFromReadWriteToken({
    token, pathname, allowedContentTypes: ["text/html"], maximumSizeInBytes: input.fileSize,
    validUntil: expiresAt, addRandomSuffix: false, allowOverwrite: false,
  })
  const payload: ArtifactUploadReceiptPayload = { version: 1, uploadId, workspaceId: input.workspaceId, pathname, filename: input.filename, fileSize: input.fileSize, expiresAt }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return { uploadId, pathname, clientToken, receipt: `${encoded}.${sign(encoded)}`, filename: input.filename, fileType: "text/html", fileSize: input.fileSize, expiresAt, access: "private" as const }
}

export function verifyArtifactUploadReceipt(receipt: string, workspaceId: string, now = Date.now()): ArtifactUploadReceiptPayload {
  const [encoded, signature, extra] = receipt.split(".")
  if (!encoded || !signature || extra) throw new Error("Invalid upload receipt")
  const expected = Buffer.from(sign(encoded))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid upload receipt")
  let payload: ArtifactUploadReceiptPayload
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) } catch { throw new Error("Invalid upload receipt") }
  if (
    payload.version !== 1 || typeof payload.uploadId !== "string" || typeof payload.workspaceId !== "string" ||
    typeof payload.pathname !== "string" || typeof payload.filename !== "string" ||
    typeof payload.fileSize !== "number" || typeof payload.expiresAt !== "number"
  ) throw new Error("Invalid upload receipt")
  if (payload.workspaceId !== workspaceId) throw new Error("Upload receipt does not belong to this workspace")
  // Defense in depth: the signed pathname must be exactly the staging path we would have minted.
  if (payload.pathname !== stagingPathname(payload.workspaceId, payload.uploadId)) throw new Error("Invalid upload receipt")
  // Expiry bounds the client-token window; the blob is single-use (deleted on consume), so no grace is needed.
  if (payload.expiresAt < now) throw new Error("Upload receipt has expired; call prepare_artifact_upload again")
  return payload
}

export type StagedArtifactUpload = {
  bytes: Uint8Array
  filename: string
  /** Best-effort removal of the staging blob once the artifact revision is committed. */
  discard: () => Promise<void>
}

/**
 * Reads the staged HTML for a verified receipt. Throws if the file was never
 * uploaded, was already consumed, or does not match the size that was signed.
 */
export async function loadStagedArtifactUpload(receipt: string, workspaceId: string, storage: ArtifactStorage): Promise<StagedArtifactUpload> {
  const payload = verifyArtifactUploadReceipt(receipt, workspaceId)
  const bytes = await storage.get(payload.pathname)
  if (!bytes) throw new Error("No uploaded file found for this receipt. Upload the file first, or it was already used.")
  if (bytes.byteLength !== payload.fileSize) throw new Error("Uploaded file size does not match the prepared upload")
  return { bytes, filename: payload.filename, discard: () => storage.del(payload.pathname).catch(() => undefined) }
}
