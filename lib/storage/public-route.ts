import { isPublicFileKey, MAX_PUBLIC_FILE_SEGMENT_LENGTH } from "@/lib/public-file-keys"

const SEGMENT = /^[A-Za-z0-9._-]+$/

/** Segment-wise validation, then the shape allowlist. Null means "not ours to serve". */
export function keyFromSegments(segments: unknown): string | null {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 6) return null
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length > MAX_PUBLIC_FILE_SEGMENT_LENGTH ||
      !SEGMENT.test(segment) || segment === "." || segment === "..") return null
  }
  const key = segments.join("/")
  return isPublicFileKey(key) ? key : null
}

/** A single `bytes=` range; anything fancier (multi-range, junk) is ignored and the whole object served. */
export function parseSingleRange(header: string | null): string | null {
  if (!header) return null
  return /^bytes=(?:\d+-\d*|-\d+)$/.test(header.trim()) ? header.trim() : null
}
