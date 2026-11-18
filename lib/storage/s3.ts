import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3"
import { createPresignedPost } from "@aws-sdk/s3-presigned-post"
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

/** Logical staging path used by direct HTML uploads (see lib/artifact-upload.ts). */
const ARTIFACT_STAGING_PREFIX = "artifact-staging/"

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
  if (store === "artifacts" && pathname.startsWith(ARTIFACT_STAGING_PREFIX)) return `tmp/${pathname}`
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
        // Presigned POST policies must not depend on an opportunistic checksum header.
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
function isMissing(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  if (name === "NoSuchKey" || name === "NotFound" || status === 404) return true
  if (name === "AccessDenied" || name === "Forbidden" || status === 403) {
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
  // ConditionalRequestConflict: a concurrent write to the same key is in flight, so it is not ours to overwrite either.
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || status === 412
}

export const PRIVATE_CACHE_CONTROL = "private, no-store"
/** Public-store keys carry a random UUID and are never overwritten, so they are immutable. */
export const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable"
/** Stored on every object so a stray direct GET downloads rather than renders. */
export const SAFE_CONTENT_DISPOSITION = "attachment"

/** Private object store for one prefix. Behaves like the Blob and disk stores. */
export function createS3Storage(store: Exclude<S3Store, "public" | "tmp">): ArtifactStorage {
  return {
    async put(pathname, bytes, contentType = "text/html; charset=utf-8", options) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      const noOverwrite = options?.overwrite === false
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          CacheControl: PRIVATE_CACHE_CONTROL,
          ContentDisposition: SAFE_CONTENT_DISPOSITION,
          // Conditional write: S3 answers 412 and leaves the existing object alone.
          ...(noOverwrite ? { IfNoneMatch: "*" } : {}),
        }))
      } catch (error) {
        if (noOverwrite && isPreconditionFailed(error)) return { pathname, created: false }
        throw error
      }
      return noOverwrite ? { pathname, created: true } : { pathname }
    },
    async get(pathname) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      const read = async (k: string) => {
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k }))
          return result.Body ? await result.Body.transformToByteArray() : null
        } catch (error) {
          if (isMissing(error)) return null // includes 403 (no ListBucket outside the prefixes)
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
          if (!result.Body) return null
          return { stream: result.Body.transformToWebStream() as ReadableStream<Uint8Array>, size: typeof result.ContentLength === "number" ? result.ContentLength : null }
        } catch (error) {
          if (isMissing(error)) return null // same not-found rule as get(), including 403
          throw error
        }
      }
      return open(key)
    },
    async del(pathname) {
      const key = s3ObjectKey(store, pathname)
      const { client, bucket } = getS3Client()
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
  }
}

export type PresignedPostTarget = {
  method: "POST"
  url: string
  /** Form fields to send verbatim, in order, before the `file` field. */
  fields: Record<string, string>
}

/**
 * Presigned POST for a browser or agent direct upload. The signed policy pins
 * the exact key, the exact content type, the exact byte length and the stored
 * cache/disposition headers, and expires with the receipt. A client that sends
 * a different size, type or key is refused by S3 itself.
 */
export async function createPresignedUpload(input: {
  store: S3Store
  pathname: string
  contentType: string
  fileSize: number
  expiresInSeconds: number
}): Promise<PresignedPostTarget> {
  if (!Number.isInteger(input.fileSize) || input.fileSize < 1) throw new Error("Invalid upload size")
  const key = s3ObjectKey(input.store, input.pathname)
  const { client, bucket } = getS3Client()
  const cacheControl = input.store === "public" ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL
  const post = await createPresignedPost(client, {
    Bucket: bucket,
    Key: key,
    Expires: input.expiresInSeconds,
    Fields: {
      "Content-Type": input.contentType,
      "Cache-Control": cacheControl,
      "Content-Disposition": SAFE_CONTENT_DISPOSITION,
    },
    Conditions: [
      ["content-length-range", input.fileSize, input.fileSize],
      ["eq", "$Content-Type", input.contentType],
      ["eq", "$Cache-Control", cacheControl],
      ["eq", "$Content-Disposition", SAFE_CONTENT_DISPOSITION],
    ],
  })
  return { method: "POST", url: post.url, fields: post.fields }
}

export type S3ObjectHead = { contentType: string | undefined; contentLength: number | undefined; etag: string | undefined }

export async function headPublicObject(key: string): Promise<S3ObjectHead | null> {
  const { client, bucket } = getS3Client()
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3ObjectKey("public", key) }))
    return { contentType: result.ContentType, contentLength: result.ContentLength, etag: result.ETag }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function putPublicObject(key: string, body: Uint8Array, contentType: string | undefined): Promise<void> {
  const { client, bucket } = getS3Client()
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: s3ObjectKey("public", key),
    Body: body,
    ContentType: contentType ?? "application/octet-stream",
    CacheControl: PUBLIC_CACHE_CONTROL,
    ContentDisposition: SAFE_CONTENT_DISPOSITION,
  }))
}

export async function deletePublicObject(key: string): Promise<void> {
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
