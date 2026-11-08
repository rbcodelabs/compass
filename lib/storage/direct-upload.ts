import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client"

/**
 * Server side of a browser (or agent) direct-to-store upload: the app hands out a
 * short-lived, path- and size-scoped credential and the bytes go straight to the
 * object store, bypassing the serverless request-body limit.
 *
 * Callers use this instead of `@vercel/blob/client`, so a deployment on another
 * store changes one implementation. The browser half is
 * `lib/storage/direct-upload-client.ts`.
 */
export type DirectUploadStore = "private" | "public"

const PRIVATE_NOT_CONFIGURED = "Private artifact storage is not configured"

/** The private store's read/write token, or null when direct upload is not set up. */
function privateStoreToken(): string | null {
  return process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim() || null
}

/** Whether a private-store direct upload can be issued at all (no local-disk fallback is considered here). */
export function privateDirectUploadConfigured(): boolean {
  return privateStoreToken() !== null
}

export type DirectUploadRequest = {
  /** `private` uses the artifact store's token; `public` uses the ambient Blob token. */
  store: DirectUploadStore
  pathname: string
  allowedContentTypes: string[]
  maxBytes: number
  /** Epoch ms after which the credential stops working. */
  validUntil: number
  /**
   * The same window as a duration, for stores whose credential is signed with a lifetime rather than an expiry
   * instant. Vercel Blob uses `validUntil` and ignores this.
   */
  ttlSeconds: number
  /** Refuse to replace an existing object at `pathname`. */
  allowOverwrite?: boolean
  /** Error message when the private store has no token. */
  notConfiguredMessage?: string
}

/**
 * The fields a prepare-upload response carries for the credential. Spread them into the response
 * (`{ ..., ...credential }`) instead of naming `clientToken`, so a store with a different credential shape
 * adds fields without every caller changing.
 */
export type DirectUploadFields = { clientToken: string }

export async function createDirectUpload(request: DirectUploadRequest): Promise<DirectUploadFields> {
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
