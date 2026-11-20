import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { PresignedUploadTarget } from "@/lib/storage/direct-upload-client"
import { s3Config } from "@/lib/storage/config"
import type { ArtifactStorage } from "@/lib/storage/types"

/**
 * Amazon S3 backend.
 *
 * One private bucket per environment, a prefix per store. Credentials come from
 * the SDK's default credential chain; no key is ever read from the
 * environment by this code. Objects carry no ACL: access is the bucket policy.
 * Encryption is left to the bucket default.
 */

export type S3Store =
  | "artifacts"
  | "capability-packs"
  | "research"
  | "agent-sessions"
  | "public"
  | "tmp"

const STAGING_PREFIXES = ["artifact-staging/", "workspace-import-staging/"]
const CONSUMED_STAGING_TYPE = "application/x-compass-consumed-upload"

/**
 * Maps a logical storage pathname to its S3 key. Rejects anything that could
 * address a different prefix: absolute paths, `.`/`..` segments, empty
 * segments, backslashes and control characters.
 *
 * One prefix rule for every store: the key is `<store>/` plus the pathname with
 * its own leading `<store>/` segment removed when it has one. Blob pathnames for
 * artifacts already begin with `artifacts/`, so `artifacts/ws/a.html` is stored
 * at `artifacts/ws/a.html`, not `artifacts/artifacts/ws/a.html`. Database
 * pathnames are not changed. The check runs on the validated pathname, so
 * `..` and empty segments can never be used to reach another store.
 *
 * Unconsumed direct-upload staging objects go under `tmp/`, so a bucket lifecycle
 * rule on that prefix can expire an abandoned upload.
 */
export function s3ObjectKey(store: S3Store, pathname: string): string {
  if (typeof pathname !== "string" || pathname.length === 0 || pathname.length > 900) {
    throw new Error("Invalid storage path")
  }
  if (/[\u0000-\u001f\u007f\\]/.test(pathname) || pathname.startsWith("/")) throw new Error("Invalid storage path")
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new Error("Invalid storage path")
  }
  if (store === "artifacts" && STAGING_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return `tmp/${pathname}`
  const prefix = `${store}/`
  return `${prefix}${pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname}`
}

let cached: { signature: string; client: S3Client } | undefined

export function getS3Client(): { client: S3Client; bucket: string } {
  const config = s3Config()
  const signature = JSON.stringify([config.region, config.forcePathStyle, process.env.AWS_ENDPOINT_URL_S3, process.env.AWS_ENDPOINT_URL])
  if (!cached || cached.signature !== signature) {
    cached = {
      signature,
      client: new S3Client({
        ...(config.region ? { region: config.region } : {}),
        ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
        // Presigned uploads must not depend on an opportunistic checksum header.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
    }
  }
  return { client: cached.client, bucket: config.bucket }
}

let lastDeniedWarningAt = 0

/**
 * A read or head of a key that is "not found" for the caller.
 *
 * A task or instance role may be granted `s3:ListBucket` only under the store prefixes,
 * and S3 answers a read of an absent key with 403 AccessDenied (not 404) to a
 * caller that cannot list. So 403 is folded into not-found here, exactly as the
 * Blob path reports a missing object, and the difference is never shown to a
 * client. A role that is genuinely mis-scoped would look the same, so a denial is
 * logged (rate-limited) for operators.
 */
function isMissing(error: unknown, strict = false): boolean {
  const name = (error as { name?: string } | null)?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  if (name === "NoSuchKey" || name === "NotFound" || status === 404) return true
  if (name === "AccessDenied" || name === "Forbidden" || status === 403) {
    if (strict) return false
    const now = Date.now()
    if (now - lastDeniedWarningAt > 60_000) {
      lastDeniedWarningAt = now
      console.warn("S3 read was denied (403); treating it as not found. If objects you expect are missing, check the task role's s3:GetObject / s3:ListBucket prefixes.")
    }
    return true
  }
  return false
}

function isPreconditionFailed(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  return name === "PreconditionFailed" || status === 412
}

async function putObjectIfAbsent(client: S3Client, input: PutObjectCommandInput): Promise<boolean> {
  const attempts = 3
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new PutObjectCommand({ ...input, IfNoneMatch: "*" }))
      return true
    } catch (error) {
      if (isPreconditionFailed(error)) return false
      const name = (error as { name?: string } | null)?.name
      if (name !== "ConditionalRequestConflict" || attempt >= attempts) throw error
    }
  }
}

export const PRIVATE_CACHE_CONTROL = "private, no-store"
/** Public objects can be removed while their URLs are still known. */
export const PUBLIC_CACHE_CONTROL = "no-store"
const DISCARDED_PUBLIC_CONTENT_TYPE = "application/x-compass-discarded"
/** Stored on every object so a stray direct GET downloads rather than renders. */
export const SAFE_CONTENT_DISPOSITION = "attachment"

/** Private object store for one prefix. Behaves like the Blob and disk stores. */
export function createS3Storage(store: Exclude<S3Store, "public" | "tmp">, { strictReads = false } = {}): ArtifactStorage {
  return {
    async put(pathname, bytes, contentType = "text/html; charset=utf-8", options) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      const noOverwrite = options?.overwrite === false
      const input = {
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: PRIVATE_CACHE_CONTROL,
        ContentDisposition: SAFE_CONTENT_DISPOSITION,
      }
      if (noOverwrite) return { pathname, created: await putObjectIfAbsent(client, input) }
      await client.send(new PutObjectCommand(input))
      return { pathname }
    },
    async get(pathname) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      const read = async (k: string) => {
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k }))
          if (result.ContentType === CONSUMED_STAGING_TYPE) {
            await result.Body?.transformToByteArray()
            return null
          }
          return result.Body ? await result.Body.transformToByteArray() : null
        } catch (error) {
          if (isMissing(error, strictReads)) return null
          throw error
        }
      }
      return read(key)
    },
    async getStream(pathname) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      const open = async (k: string) => {
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k }))
          if (result.ContentType === CONSUMED_STAGING_TYPE) {
            await result.Body?.transformToByteArray()
            return null
          }
          if (!result.Body) return null
          return { stream: result.Body.transformToWebStream() as ReadableStream<Uint8Array>, size: typeof result.ContentLength === "number" ? result.ContentLength : null }
        } catch (error) {
          if (isMissing(error, strictReads)) return null
          throw error
        }
      }
      return open(key)
    },
    async claimStagedUpload(pathname) {
      const stagingKey = s3ObjectKey(store, pathname)
      if (!stagingKey.startsWith("tmp/")) throw new Error("Invalid upload staging path")
      const key = `${stagingKey}.claim`
      const { client, bucket } = getS3Client()
      const created = await putObjectIfAbsent(client, {
        Bucket: bucket, Key: key, Body: new Uint8Array(), CacheControl: PRIVATE_CACHE_CONTROL,
      })
      if (!created) throw new Error("This upload receipt is already used or is being committed")
      return async () => { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })) }
    },
    async del(pathname) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      if (key.startsWith("tmp/")) {
        // Keep the key occupied while a previously issued create-only URL can
        // still be used. The bucket lifecycle expires this marker later.
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: new Uint8Array(),
          ContentType: CONSUMED_STAGING_TYPE,
          CacheControl: PRIVATE_CACHE_CONTROL,
          ContentDisposition: SAFE_CONTENT_DISPOSITION,
        }))
        return
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
  }
}

/** Sign a create-only upload with an exact object length and type. */
export async function createPresignedUpload(input: {
  store: S3Store
  pathname: string
  contentType: string
  fileSize: number
  expiresInSeconds: number
}): Promise<PresignedUploadTarget> {
  if (!Number.isInteger(input.fileSize) || input.fileSize < 1) throw new Error("Invalid upload size")
  const key = s3ObjectKey(input.store, input.pathname)
  const { client, bucket } = getS3Client()
  const headers = {
    "If-None-Match": "*",
    "Content-Type": input.contentType,
    "Cache-Control": input.store === "public" ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL,
    "Content-Disposition": SAFE_CONTENT_DISPOSITION,
  }
  const url = await getSignedUrl(client, new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    IfNoneMatch: headers["If-None-Match"],
    ContentType: headers["Content-Type"],
    ContentLength: input.fileSize,
    CacheControl: headers["Cache-Control"],
    ContentDisposition: headers["Content-Disposition"],
  }), {
    expiresIn: input.expiresInSeconds,
    signableHeaders: new Set([...Object.keys(headers).map((name) => name.toLowerCase()), "content-length"]),
  })
  // Browsers and curl supply Content-Length from the raw file body.
  return { method: "PUT", url, headers }
}

export type S3ObjectHead = { contentType: string | undefined; contentLength: number | undefined; etag: string | undefined }

export async function headPublicObject(key: string): Promise<S3ObjectHead | null> {
  const { client, bucket } = getS3Client()
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3ObjectKey("public", key) }))
    if (result.ContentType === DISCARDED_PUBLIC_CONTENT_TYPE) return null
    return { contentType: result.ContentType, contentLength: result.ContentLength, etag: result.ETag }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function putPublicObject(key: string, body: Uint8Array, contentType: string | undefined): Promise<void> {
  const { client, bucket } = getS3Client()
  const created = await putObjectIfAbsent(client, {
    Bucket: bucket,
    Key: s3ObjectKey("public", key),
    Body: body,
    ContentType: contentType ?? "application/octet-stream",
    CacheControl: PUBLIC_CACHE_CONTROL,
    ContentDisposition: SAFE_CONTENT_DISPOSITION,
  })
  // No successful return means the caller cannot register this key for rollback cleanup.
  if (!created) throw new Error("Public file already exists")
}

export async function deletePublicObject(key: string): Promise<void> {
  const { client, bucket } = getS3Client()
  const Key = s3ObjectKey("public", key)
  if (key.startsWith("feedback/")) {
    // Reserve the key even if the client never used its create-only signed PUT.
    await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: new Uint8Array(),
      ContentType: DISCARDED_PUBLIC_CONTENT_TYPE, CacheControl: PUBLIC_CACHE_CONTROL }))
    return
  }
  await removeServerWrittenPublicObject(key)
}

/** Remove a server-written object that has never had a presigned PUT. */
export async function removeServerWrittenPublicObject(key: string): Promise<void> {
  const { client, bucket } = getS3Client()
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3ObjectKey("public", key) }))
}

export type PublicObjectRead =
  | { kind: "ok"; result: GetObjectCommandOutput }
  | { kind: "not-found" }
  | { kind: "not-modified"; etag: string | undefined }
  | { kind: "invalid-range" }

/** Streams a public object, passing Range and If-None-Match through to S3. */
export async function getPublicObject(key: string, options: { range?: string; ifNoneMatch?: string } = {}): Promise<PublicObjectRead> {
  const { client, bucket } = getS3Client()
  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: s3ObjectKey("public", key),
      ...(options.range ? { Range: options.range } : {}),
      ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
    }))
    if (result.ContentType === DISCARDED_PUBLIC_CONTENT_TYPE) {
      await result.Body?.transformToByteArray()
      return { kind: "not-found" }
    }
    return { kind: "ok", result }
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
    const name = (error as { name?: string } | null)?.name
    if (status === 304 || name === "NotModified") return { kind: "not-modified", etag: options.ifNoneMatch }
    if (status === 416 || name === "InvalidRange") return { kind: "invalid-range" }
    if (isMissing(error)) return { kind: "not-found" }
    throw error
  }
}
