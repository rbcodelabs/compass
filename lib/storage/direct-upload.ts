import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client"
import { resolveStorageBackend } from "@/lib/storage/config"
import { createPresignedUpload } from "@/lib/storage/s3"
import type { PresignedUploadTarget } from "@/lib/storage/direct-upload-client"
import type { ArtifactStorage } from "@/lib/storage/types"
import { publicFileUrl } from "@/lib/public-file-keys"

/**
 * Server side of a browser (or agent) direct-to-store upload: the app hands out a
 * short-lived, path- and size-scoped credential and the bytes go straight to the
 * object store, bypassing the serverless request-body limit.
 *
 * Callers use this instead of a storage SDK, so a deployment on another store
 * changes one implementation. The browser half is `lib/storage/direct-upload-client.ts`.
 *
 * Backends: Vercel Blob (a client token) and S3 (a presigned PUT that pins the key,
 * the exact content type and the exact byte length). The local-disk backend has no
 * direct upload; callers gate on {@link directUploadAvailable} first where that matters.
 */
export type DirectUploadStore = "private" | "public"

const PRIVATE_NOT_CONFIGURED = "Private artifact storage is not configured"

/** The private store's Blob read/write token, or null when it is not set. */
function privateStoreToken(): string | null {
  return process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim() || null
}

/** Whether a private-store direct upload can be issued at all. */
export function privateDirectUploadConfigured(): boolean {
  if (resolveStorageBackend() === "s3") {
    return Boolean(process.env.COMPASS_S3_BUCKET?.trim() && privateUploadReceiptSecret())
  }
  return privateStoreToken() !== null
}

export function privateUploadReceiptSecret(): string | null {
  return process.env.ARTIFACT_UPLOAD_RECEIPT_SECRET?.trim() || privateStoreToken()
}

/** Bind a storage claim to the caller's actual commit, after it validates the staged bytes. */
export function stagedUploadCommit(storage: ArtifactStorage, pathname: string) {
  return async function commit<T>(apply: () => Promise<T>, record?: (result: T) => Promise<void>): Promise<T> {
    const release = await storage.claimStagedUpload?.(pathname)
    let result: T
    try {
      result = await apply()
    } catch (error) {
      await release?.().catch(() => undefined)
      throw error
    }
    await record?.(result)
    await storage.del(pathname).catch(() => undefined)
    return result
  }
}

export type DirectUploadRequest = {
  /** `private` is the artifact/research store; `public` is the shareable-URL store. */
  store: DirectUploadStore
  pathname: string
  allowedContentTypes: string[]
  /** Exact byte length the uploader declared. Blob treats it as a ceiling; S3 pins it exactly. */
  maxBytes: number
  /** Epoch ms after which a Blob credential stops working. */
  validUntil: number
  /** How long an S3 presigned PUT stays valid. */
  ttlSeconds: number
  /** Refuse to replace an existing object at `pathname`; S3 uploads are always create-only. */
  allowOverwrite?: boolean
  /** Error message when the private Blob store has no token. */
  notConfiguredMessage?: string
}

/**
 * The fields a prepare-upload response carries for the credential. `clientToken` is
 * always present (empty on S3) so the response shape does not depend on the backend;
 * `upload` (and `url` for the public store) appear only on S3.
 */
export type BlobDirectUploadFields = { clientToken: string }
export type S3DirectUploadFields = { clientToken: ""; upload: PresignedUploadTarget; backend: "s3" }

export async function createDirectUpload(request: DirectUploadRequest & { store: "public" }): Promise<BlobDirectUploadFields | (S3DirectUploadFields & { url: string })>
export async function createDirectUpload(request: DirectUploadRequest & { store: "private" }): Promise<BlobDirectUploadFields | S3DirectUploadFields>
export async function createDirectUpload(request: DirectUploadRequest): Promise<BlobDirectUploadFields | S3DirectUploadFields | (S3DirectUploadFields & { url: string })> {
  if (resolveStorageBackend() === "s3") {
    // For the public store, publicFileUrl() refuses a pathname the serving route would not serve.
    const url = request.store === "public" ? publicFileUrl(request.pathname) : undefined
    const upload = await createPresignedUpload({
      store: request.store === "public" ? "public" : "artifacts",
      pathname: request.pathname,
      contentType: request.allowedContentTypes[0],
      fileSize: request.maxBytes,
      expiresInSeconds: request.ttlSeconds,
    })
    return { clientToken: "", upload, backend: "s3", ...(url ? { url } : {}) } as S3DirectUploadFields
  }
  return { clientToken: await createDirectUploadToken(request) }
}

/** Mint a Vercel Blob client token. Throws when the store is not configured. */
export async function createDirectUploadToken(request: DirectUploadRequest): Promise<string> {
  const token = request.store === "private" ? privateStoreToken() : undefined
  if (request.store === "private" && !token) throw new Error(request.notConfiguredMessage ?? PRIVATE_NOT_CONFIGURED)
  return generateClientTokenFromReadWriteToken({
    ...(token ? { token } : {}),
    pathname: request.pathname,
    allowedContentTypes: request.allowedContentTypes,
    maximumSizeInBytes: request.maxBytes,
    validUntil: request.validUntil,
    addRandomSuffix: false,
    ...(request.allowOverwrite !== undefined ? { allowOverwrite: request.allowOverwrite } : {}),
  })
}
