/**
 * Feedback attachment limits — pure data, safe to import from client
 * components.
 *
 * `lib/feedback-attachments.ts` is the server-side owner of storage and
 * verification, but it imports `node:crypto` and `@vercel/blob`, so a client
 * component cannot import it without dragging server code into the bundle.
 * These constants live here instead and are re-exported from there, so the
 * browser-side pre-checks and the server-side enforcement can never drift.
 * The server remains the authority: every rule below is re-checked when the
 * upload is prepared and again when the finished upload is verified.
 */

export const FEEDBACK_ATTACHMENT_MAX_COUNT = 5
export const FEEDBACK_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
] as const

/**
 * How long after its 10-minute token window an upload receipt is still
 * accepted from the in-app composer. People attach a screenshot first and then
 * write; a draft restored the next morning should still submit. The receipt is
 * HMAC-bound to one workspace, pathname, type and size, and the blob itself is
 * re-read with `head()` before it is trusted, so the grace only extends *when*
 * a verified upload may be linked — never *what* may be linked. The composer
 * uses the same number to decide which saved attachments are still restorable.
 */
export const IN_APP_RECEIPT_GRACE_MS = 24 * 60 * 60 * 1000

/** `accept` attribute for a file input, derived from the allowlist. */
export const FEEDBACK_ATTACHMENT_ACCEPT = FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES.join(",")

/** One human-readable line describing the limits, for hints and errors. */
export const FEEDBACK_ATTACHMENT_LIMITS_HINT =
  "PNG, JPEG, GIF, WebP, PDF, TXT or CSV · up to 10 MB each · max 5"

const allowed = new Set<string>(FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES)

export function isAllowedFeedbackAttachmentType(fileType: string): boolean {
  return allowed.has(fileType)
}

/**
 * Client-side pre-check for a file the user is trying to attach. Returns a
 * user-facing reason, or `null` when the file may be uploaded. Checking here
 * saves a round trip for the obvious cases; it is not a security boundary.
 */
export function feedbackAttachmentRejection(
  file: { name: string; size: number; type: string },
): string | null {
  if (!file.name || file.name.length > 255) return "File names must be 255 characters or fewer."
  if (!isAllowedFeedbackAttachmentType(file.type)) {
    return `${file.name}: unsupported file type. Use PNG, JPEG, GIF, WebP, PDF, TXT or CSV.`
  }
  if (file.size < 1) return `${file.name} is empty.`
  if (file.size > FEEDBACK_ATTACHMENT_MAX_FILE_BYTES) return `${file.name} is larger than 10 MB.`
  return null
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
