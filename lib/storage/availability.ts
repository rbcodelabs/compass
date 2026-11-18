import { resolveStorageBackend } from "@/lib/storage/config"

/**
 * Whether this deployment can store feedback attachments at all: the S3 backend
 * needs only its bucket, Vercel Blob needs the public-store token.
 */
export function feedbackAttachmentsAvailable(): boolean {
  try {
    if (resolveStorageBackend() === "s3") return Boolean(process.env.COMPASS_S3_BUCKET?.trim())
  } catch {
    return false
  }
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}
