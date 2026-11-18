import { parsePublicFileUrl } from "@/lib/public-file-keys"
import { configuredBlobStoreHostname } from "@/lib/feedback-attachments"

/**
 * Storage-path confinement for workspace import.
 *
 * A bundle is attacker-controlled input. Every storage path or blob key it carries (`*Pathname` columns, manifest
 * blob keys) is only ever honoured if it lives under the SOURCE workspace's own prefix in its store, and the
 * rewritten path (source ids -> the new import's ids) lives under the NEW workspace's prefix. Anything else is
 * rejected, so an import can neither read nor write an object that belongs to another workspace.
 */

export type PrivateBlobStore = "artifact" | "research"

/** Path roots a workspace owns in each private store. The workspace id is always the second segment. */
const ROOTS: Readonly<Record<PrivateBlobStore, readonly string[]>> = {
  artifact: ["artifacts", "docs"],
  research: ["research"],
}

const MAX_PATH_LENGTH = 900

/** No absolute paths, backslashes, control characters, or empty / dot segments. */
export function isSafeStoragePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return false
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith("/")) return false
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function underWorkspacePrefix(store: PrivateBlobStore, path: string, workspaceId: string): boolean {
  const segments = path.split("/")
  return (
    segments.length >= 3 &&
    ROOTS[store].includes(segments[0]!) &&
    segments[1]!.toLowerCase() === workspaceId.toLowerCase()
  )
}

/**
 * Returns the path the object must be stored at in the new workspace, or null when `key` is not confined to the
 * source workspace's prefix (or the rewritten result is not confined to the new workspace's prefix).
 */
export function confineStoragePath(
  store: PrivateBlobStore,
  key: unknown,
  sourceWorkspaceId: string,
  newWorkspaceId: string,
  rewrite: (text: string) => string,
): string | null {
  if (!isSafeStoragePath(key)) return null
  if (!underWorkspacePrefix(store, key, sourceWorkspaceId)) return null
  const rewritten = rewrite(key)
  if (!isSafeStoragePath(rewritten)) return null
  return underWorkspacePrefix(store, rewritten, newWorkspaceId) ? rewritten : null
}

/** Capability-pack artifacts are content addressed and shared, so the only valid path is the one its digest names. */
export function capabilityPackArtifactPath(pathname: unknown, sha256: unknown): string | null {
  if (typeof pathname !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null
  return pathname === `capability-packs/sha256/${sha256}.json` ? pathname : null
}

/**
 * True only for a feedback-attachment URL this deployment itself hands out for the SOURCE workspace (another
 * workspace's attachment must never be kept, or a later export or purge would read or delete it): an https URL on the
 * configured Vercel Blob public store's exact hostname, under `feedback/{sourceWorkspaceId}/`. Anything else is never
 * fetched on export and never kept.
 */
export function isOwnFeedbackAttachmentUrl(url: unknown, sourceWorkspaceId: string): url is string {
  if (typeof url !== "string" || !url) return false
  const ownSegment = `feedback/${sourceWorkspaceId.toLowerCase()}/`
  if (parsePublicFileUrl(url)?.toLowerCase().startsWith(ownSegment)) return true
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.hostname.toLowerCase() === configuredBlobStoreHostname() &&
      parsed.pathname.slice(1).toLowerCase().startsWith(ownSegment) &&
      !/%2e|%2f|%5c/i.test(url)
    )
  } catch {
    return false
  }
}
