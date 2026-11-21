import { deletePublicObject, putPublicObject } from "@/lib/storage/s3"
import { parsePublicFileUrl, publicFileUrl } from "@/lib/public-file-keys"

/**
 * Write side of the "public" store on the S3 backend.
 *
 * Callers keep their Vercel Blob code path untouched and branch to these
 * helpers only when `resolveStorageBackend() === "s3"`. The stored URL is the
 * app route (`/api/files/public/<key>`), never a bucket or presigned URL.
 *
 * Keys are validated against the allowed shapes before anything is written, so
 * a coding mistake cannot create an object the route would refuse to serve (or,
 * worse, one in an unintended prefix).
 */

export async function putS3PublicFile(input: { key: string; body: Uint8Array; contentType?: string | undefined }): Promise<{ url: string }> {
  const url = publicFileUrl(input.key) // throws unless the key has an allowed, random-bearing shape
  await putPublicObject(input.key, input.body, input.contentType)
  return { url }
}

/** Best-effort removal of public-store objects named by app-route URLs. Other URLs are skipped. */
export async function deleteS3PublicFilesByUrl(urls: string[]): Promise<void> {
  for (const url of urls) {
    const key = parsePublicFileUrl(url)
    if (key) await deletePublicObject(key)
  }
}
