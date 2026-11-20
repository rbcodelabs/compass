/**
 * Public-file route naming, shared by the route handler, the proxy's public-path
 * list and the feedback / embed validators.
 *
 * Pure on purpose (no SDK, no `node:` imports): `lib/route-access.ts` imports it,
 * and that file must stay trivially unit-testable.
 *
 * ## What "public" means here
 *
 * With the Vercel Blob backend, three kinds of object live in one *public* store
 * and are readable by anyone holding the (unguessable) URL: feedback attachments,
 * embed element screenshots and workspace branding logos. With the S3 backend the
 * bucket is private, so those objects live under the `public/` prefix and Compass
 * serves them itself at `/api/files/public/<key>`.
 *
 * The exposure must not widen. Therefore the route serves a key only if it matches
 * one of the shapes below, and every shape contains a random UUID that the server,
 * not the caller, generated. A key that is anything else (a private prefix, a
 * traversal, a guessable name) is not served, session or no session.
 */

/** Only store the route will ever serve. Private stores have their own authorized routes. */
export const PUBLIC_FILE_STORE = "public"
export const PUBLIC_FILE_ROUTE_PREFIX = `/api/files/${PUBLIC_FILE_STORE}/`

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
/** Opaque row ids (cuid / uuid). No dots, so a segment can never be `.` or `..`. */
const ID = "[A-Za-z0-9_-]{1,64}"
/** The tail of a sanitized filename (`sanitizeFeedbackAttachmentFilename` output). */
const MAX_FILENAME_LENGTH = 255
const NAME = `[A-Za-z0-9._-]{1,${MAX_FILENAME_LENGTH}}`
export const MAX_PUBLIC_FILE_SEGMENT_LENGTH = 36 + 1 + MAX_FILENAME_LENGTH

const PUBLIC_KEY_PATTERNS: readonly RegExp[] = [
  new RegExp(`^feedback/${ID}/${UUID}-${NAME}$`),
  new RegExp(`^embed-feedback/${ID}/${ID}/capture-${UUID}\\.(?:jpg|png|webp)$`),
  new RegExp(`^branding/${UUID}-${NAME}$`),
]

/** Hard ceiling, well under S3's 1024-byte key limit once the `public/` prefix is added. */
const MAX_PUBLIC_KEY_LENGTH = 600

/** True only for keys the server itself would have minted for the public store. */
export function isPublicFileKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_PUBLIC_KEY_LENGTH) return false
  return PUBLIC_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/** `/api/files/public/<key>` for a validated key. Filename characters are already URL-safe. */
export function publicFileUrl(key: string): string {
  if (!isPublicFileKey(key)) throw new Error("Not a public file key")
  return `${PUBLIC_FILE_ROUTE_PREFIX}${key}`
}

/**
 * Inverse of {@link publicFileUrl}: the key a stored URL points at, or null when
 * the value is anything other than the exact relative route form. Absolute URLs,
 * query strings, fragments and percent-escapes are all refused.
 */
export function parsePublicFileUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(PUBLIC_FILE_ROUTE_PREFIX)) return null
  const key = value.slice(PUBLIC_FILE_ROUTE_PREFIX.length)
  return isPublicFileKey(key) ? key : null
}

/**
 * Whether the proxy may let this request through without a session. Matches the
 * raw (still-encoded) pathname, so any `%` fails and falls back to the login
 * redirect; the route handler then validates again (two independent checks).
 */
export function isPublicFilePath(pathname: string): boolean {
  return parsePublicFileUrl(pathname) !== null
}

/** Accept only attachment keys owned by the workspace being purged. */
export function ownedS3FeedbackUrls(workspaceId: string, attachments: { url: string }[]): string[] {
  return [...new Set(attachments.map(({ url }) => url).filter((url) =>
    parsePublicFileUrl(url)?.startsWith(`feedback/${workspaceId}/`),
  ))]
}
