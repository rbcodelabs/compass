import type { ImportReport } from "@/lib/workspace-export/import"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { shouldUseLocalStorage, type ArtifactStorage } from "@/lib/artifact-storage"
import { createDirectUpload, privateDirectUploadConfigured, privateUploadReceiptSecret, stagedUploadCommit } from "@/lib/storage/direct-upload"

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
  const s = privateUploadReceiptSecret()
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
  const payload: Payload = { v: 1, uploadId, organizationId: input.organizationId, userId: input.userId, pathname, fileSize: input.fileSize, expiresAt }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const receipt = `${encoded}.${sign(encoded)}`
  const credential = await createDirectUpload({
    store: "private", pathname, allowedContentTypes: ["application/zip", "application/octet-stream"], maxBytes: input.fileSize,
    validUntil: expiresAt, ttlSeconds: TTL_MS / 1000, allowOverwrite: false, notConfiguredMessage: "Direct upload is not configured",
  })
  return { uploadId, pathname, ...credential, receipt, expiresAt, access: "private" as const }
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

type ResultLookup = { canReleaseClaim?: (error: unknown) => boolean; nonce?: string; persistResult: boolean; recover?: (bytes: Uint8Array, nonce: string) => Promise<ImportReport | undefined> }
type StagedBundle = { bytes: Uint8Array; nonce?: string; commit: (apply: () => Promise<ImportReport>) => Promise<ImportReport> }
export function loadStagedBundle(receipt: string, organizationId: string, userId: string, storage: ArtifactStorage): Promise<StagedBundle>
export function loadStagedBundle(receipt: string, organizationId: string, userId: string, storage: ArtifactStorage, lookup: ResultLookup): Promise<StagedBundle | { result: ImportReport }>
export async function loadStagedBundle(receipt: string, organizationId: string, userId: string, storage: ArtifactStorage, lookup?: ResultLookup): Promise<StagedBundle | { result: ImportReport }> {
  const p = verifyBundleReceipt(receipt, organizationId, userId)
  const nonce = lookup?.persistResult ? lookup.nonce ?? p.uploadId : undefined
  const nonceHash = nonce === undefined ? undefined : createHash("sha256").update(JSON.stringify(nonce)).digest("hex")
  const bindingPath = nonceHash === undefined ? undefined : `${p.pathname}.nonce`
  const assertBinding = async (): Promise<boolean> => {
    if (!bindingPath) return false
    const binding = await storage.get(bindingPath)
    if (!binding) return false
    if (Buffer.from(binding).toString("utf8") !== nonceHash) {
      throw new Error("This upload receipt is bound to a different nonce")
    }
    return true
  }
  const bound = await assertBinding()
  const resultPath = nonceHash === undefined ? undefined : `${p.pathname}.result-${nonceHash}`
  if (bound && resultPath) {
    const recorded = await storage.get(resultPath)
    if (recorded) return { result: JSON.parse(Buffer.from(recorded).toString("utf8")) as ImportReport }
  }
  const bytes = await storage.get(p.pathname)
  if (!bytes) throw new Error("No uploaded bundle found for this receipt")
  if (bytes.byteLength !== p.fileSize) throw new Error("Uploaded bundle size does not match the prepared upload")
  const record = resultPath ? async (result: ImportReport) => {
    await storage.put(resultPath, Buffer.from(JSON.stringify(result)), "application/json")
  } : undefined
  if (bound && record && nonce !== undefined) {
    const recovered = await lookup?.recover?.(bytes, nonce)
    if (recovered) {
      // The database result is authoritative. Keep the ZIP as recovery evidence
      // if the sidecar cannot be written yet.
      const stored = await record(recovered).then(() => true, () => false)
      if (stored) await storage.del(p.pathname).catch(() => undefined)
      return { result: recovered }
    }
  }
  const commit = stagedUploadCommit(storage, p.pathname)
  return { bytes, nonce, commit: (apply) => commit(async () => {
    if (bindingPath && nonceHash !== undefined && !(await assertBinding())) {
      await storage.put(bindingPath, Buffer.from(nonceHash), "text/plain", { overwrite: false })
      if (!(await assertBinding())) throw new Error("Could not verify upload receipt binding")
    }
    return apply()
  }, record, lookup?.canReleaseClaim) }
}
