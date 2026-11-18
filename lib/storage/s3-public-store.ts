import { randomUUID } from "node:crypto"
import { parsePublicFileUrl } from "@/lib/public-file-keys"
import { vercelBlobPublicFileStore } from "@/lib/storage/blob-public-store"
import type { PublicFileStore } from "@/lib/storage/public-store"
import { deleteS3PublicFilesByUrl, putS3PublicFile } from "@/lib/storage/public-files"
import { getPublicObject } from "@/lib/storage/s3"

/**
 * {@link PublicFileStore} on the S3 backend. The bucket is private; "public" files live
 * under the `public/` prefix and are served by `/api/files/public/<key>`, so the URL a
 * caller gets back is the app route, never a bucket or presigned URL.
 *
 * Callers pick a Blob-style pathname (`<prefix>/<timestamp-or-uuid>-<name>`). The route
 * only serves keys with a server-generated UUID in them (see `lib/public-file-keys.ts`),
 * so the timestamp is replaced with one and the name is sanitized. A pathname that cannot
 * become a servable key throws instead of storing an object the route would refuse.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const LEADING = new RegExp(`^(${UUID}|\\d+)-(.+)$`, "i")
const EMBED_CAPTURE = /^capture(?:-[0-9a-f-]{36})?\.(jpg|png|webp)$/i

export function publicKeyForPathname(pathname: string): string {
  const parts = pathname.split("/")
  const last = parts.pop() ?? ""
  if (parts[0] === "embed-feedback") {
    const match = EMBED_CAPTURE.exec(last)
    if (!match) throw new Error("Not a public file pathname")
    return [...parts, `capture-${randomUUID()}.${match[1]!.toLowerCase()}`].join("/")
  }
  const match = LEADING.exec(last)
  const lead = match && new RegExp(`^${UUID}$`, "i").test(match[1]!) ? match[1]! : randomUUID()
  let name = (match ? match[2]! : last).replace(/[^a-zA-Z0-9._-]/g, "_") // same rule as sanitizeFeedbackAttachmentFilename
  if (parts[0] === "branding") name = name.slice(0, 100) || "logo"
  return [...parts, `${lead}-${name}`].join("/")
}

export const s3PublicFileStore: PublicFileStore = {
  async put(pathname, body, options = {}) {
    const bytes = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body
    // A Blob carries its own type; callers that pass a File (the branding logo) rely on that, as they do with Vercel Blob.
    const contentType = options.contentType ?? (body instanceof Blob && body.type ? body.type : undefined)
    return putS3PublicFile({ key: publicKeyForPathname(pathname), body: bytes, contentType })
  },
  /**
   * A deployment that moved from Blob to S3 still has rows holding bucket-less Blob URLs next to app-route
   * URLs, so each goes to the store that owns it. Both are attempted; the first failure is rethrown.
   */
  async delete(urls) {
    const routeUrls = urls.filter((url) => parsePublicFileUrl(url) !== null)
    const blobUrls = urls.filter((url) => parsePublicFileUrl(url) === null)
    const results = await Promise.allSettled([
      routeUrls.length ? deleteS3PublicFilesByUrl(routeUrls) : Promise.resolve(),
      blobUrls.length ? vercelBlobPublicFileStore.delete(blobUrls) : Promise.resolve(),
    ])
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
    if (failed) throw failed.reason
  },
  async fetch(url) {
    const key = parsePublicFileUrl(url)
    if (!key) return null
    const read = await getPublicObject(key)
    if (read.kind !== "ok" || !read.result.Body) return null
    return {
      bytes: await read.result.Body.transformToByteArray(),
      contentType: read.result.ContentType ?? "application/octet-stream",
    }
  },
}
