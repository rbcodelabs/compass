import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { shouldUseLocalStorage, type ArtifactStorage } from "@/lib/artifact-storage"
import { createDirectUploadToken, privateDirectUploadConfigured } from "@/lib/storage/direct-upload"

/**
 * Direct-to-Blob staging for workspace bundles. A bundle can be far larger than a serverless request body
 * allows, so the browser uploads it straight to private Blob under a signed, organization-scoped path and
 * the import route reads it from there (and deletes it). Locally (no Blob) the multipart path is used.
 */

/** Upper bound for a bundle, enforced on prepare (declared size), on the signed client token (maximumSizeInBytes) and on the multipart route. */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024
/** Largest bundle accepted through the multipart route (a serverless request body is capped near 4.5 MB). */
export const MAX_MULTIPART_BYTES = 4 * 1024 * 1024
const TTL_MS = 30 * 60 * 1000

type Payload = { v: 1; uploadId: string; organizationId: string; userId: string; pathname: string; fileSize: number; expiresAt: number }

function secret(): string {
  const s = process.env.ARTIFACT_UPLOAD_RECEIPT_SECRET?.trim() || process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim()
  if (!s) throw new Error("Workspace import uploads are not configured")
  return s
}
const sign = (encoded: string) => createHmac("sha256", secret()).update(`workspace-import:v1:${encoded}`).digest("base64url")
const stagingPath = (organizationId: string, uploadId: string) => `workspace-import-staging/${organizationId}/${uploadId}.zip`

export function directUploadAvailable(): boolean {
  return !shouldUseLocalStorage() && privateDirectUploadConfigured()
}

export async function prepareBundleUpload(input: { organizationId: string; userId: string; fileSize: number }, now = Date.now()) {
  if (!Number.isInteger(input.fileSize) || input.fileSize < 1) throw new Error("The file is empty")
  if (input.fileSize > MAX_BUNDLE_BYTES) throw new Error("The bundle exceeds the 512 MB limit")
  const uploadId = randomUUID()
  const pathname = stagingPath(input.organizationId, uploadId)
  const expiresAt = now + TTL_MS
  const clientToken = await createDirectUploadToken({
    store: "private", pathname, allowedContentTypes: ["application/zip", "application/octet-stream"], maxBytes: input.fileSize,
    validUntil: expiresAt, allowOverwrite: false, notConfiguredMessage: "Direct upload is not configured",
  })
  const payload: Payload = { v: 1, uploadId, organizationId: input.organizationId, userId: input.userId, pathname, fileSize: input.fileSize, expiresAt }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return { uploadId, pathname, clientToken, receipt: `${encoded}.${sign(encoded)}`, expiresAt, access: "private" as const }
}

export function verifyBundleReceipt(receipt: string, organizationId: string, userId: string, now = Date.now()): Payload {
  const [encoded, signature, extra] = receipt.split(".")
  if (!encoded || !signature || extra) throw new Error("Invalid upload receipt")
  const expected = Buffer.from(sign(encoded))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid upload receipt")
  let p: Payload
  try {
    p = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid upload receipt")
  }
  if (p.v !== 1 || p.organizationId !== organizationId || p.userId !== userId) throw new Error("Upload receipt does not belong to this organization")
  if (p.pathname !== stagingPath(p.organizationId, p.uploadId)) throw new Error("Invalid upload receipt")
  if (p.expiresAt < now) throw new Error("Upload receipt has expired; upload the file again")
  return p
}

export async function loadStagedBundle(receipt: string, organizationId: string, userId: string, storage: ArtifactStorage) {
  const p = verifyBundleReceipt(receipt, organizationId, userId)
  const bytes = await storage.get(p.pathname)
  if (!bytes) throw new Error("No uploaded bundle found for this receipt")
  if (bytes.byteLength !== p.fileSize) throw new Error("Uploaded bundle size does not match the prepared upload")
  return { bytes, discard: () => storage.del(p.pathname).catch(() => undefined) }
}
