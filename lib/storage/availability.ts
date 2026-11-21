import { resolveStorageBackend } from "@/lib/storage/config"

/**
 * Whether this deployment can issue direct feedback attachment uploads.
 */
export function feedbackAttachmentsAvailable(): boolean {
  try {
    if (resolveStorageBackend() === "s3") {
      return Boolean(process.env.COMPASS_S3_BUCKET?.trim() && feedbackUploadReceiptSecret())
    }
  } catch {
    return false
  }
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

export function feedbackUploadReceiptSecret(): string | undefined {
  return process.env.FEEDBACK_UPLOAD_RECEIPT_SECRET?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim()
}
