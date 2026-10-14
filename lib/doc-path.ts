/**
 * Pure path rules for the docs virtual filesystem (ADR 0019 §1.1). No I/O, no
 * Prisma, so both lib/doc-fs.ts and the sandbox callback validation can share it
 * without pulling a database client into either.
 */

export const MAX_SEGMENT_BYTES = 200
/** Deepest doc nesting the sandbox's wiki walk can enumerate (maxDepth 32, minus the `_doc.md` leaf and a margin). */
export const MAX_DOC_DEPTH = 30
// eslint-disable-next-line no-control-regex
// `$` and `%` are escaped too: the agent's file tools refuse any path containing
// them (the CLI expands variables in a path), so a doc named "50% off" would
// otherwise be unreadable to the agent that is meant to edit it.
const ILLEGAL_CHARS = /[/\\:*?"<>|$%\x00-\x1f\x7f-\x9f]/g

/**
 * The wiki session the sandbox reads its tree through (`@rbcodelabs/geode-headless/wiki`)
 * skips dot-prefixed names and `node_modules` during its walk, so a doc whose path
 * contained one would be invisible to the sandbox and look "deleted" at reconciliation.
 * Titles are therefore escaped at the source rather than refused.
 */
export function isWikiExcludedSegment(segment: string): boolean {
  return segment.startsWith(".") || segment === "node_modules"
}

/** Reserved: `_doc.md` is a doc's own content file, so a child directory may not use that name. */
const RESERVED_SEGMENT = "_doc.md"

/**
 * A path segment is the doc's title, lightly sanitized — not a slugified
 * lowercase string (spec §1.1). Filesystem-illegal characters become `_`;
 * leading/trailing whitespace and trailing dots are trimmed; a leading dot (or
 * the names `node_modules` / `_doc.md`) is escaped with `_`; length is capped
 * at 200 UTF-8 bytes (truncate, not reject).
 */
export function sanitizeTitleSegment(title: string): string {
  let s = title.replace(ILLEGAL_CHARS, "_").trim()
  while (s.endsWith(".")) s = s.slice(0, -1)
  s = s.trim()
  if (!s) s = "Untitled"
  const buf = Buffer.from(s, "utf8")
  if (buf.byteLength > MAX_SEGMENT_BYTES) {
    // toString("utf8") replaces a truncated trailing multi-byte sequence with
    // U+FFFD rather than throwing — strip it so a byte-boundary cut never
    // leaves a mangled replacement character at the end of the segment.
    s = buf.subarray(0, MAX_SEGMENT_BYTES).toString("utf8").replace(/�+$/, "").trim()
    while (s.endsWith(".")) s = s.slice(0, -1)
    if (!s) s = "Untitled"
  }
  // A leading/trailing quote makes the file tools treat the path as quoted (and refuse it).
  s = s.replace(/^['`]|['`]$/g, "_")
  if (s.startsWith(".")) s = s.replace(/^\.+/, (dots) => "_".repeat(dots.length))
  if (s === "node_modules" || s === RESERVED_SEGMENT) s = `${s}_`
  return s
}

/**
 * Why `path` is not a path this layer could have produced, or null when it is.
 * The callback applies this to every path a sandbox reports: a segment is valid
 * only if sanitizing it is a no-op, which rejects dot-segments, `..`, NUL and
 * control characters, `:`, separators, wiki-excluded names, and over-long names
 * in one rule instead of a list that can drift.
 */
export function validateDocPath(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string"
  if (path.length > 4096) return "path is too long"
  const segments = path.split("/")
  if (segments.length > MAX_DOC_DEPTH) return "path is nested too deeply"
  for (const segment of segments) {
    if (segment === "") return "path has an empty segment"
    if (segment === "." || segment === "..") return "path has a dot segment"
    if (sanitizeTitleSegment(segment) !== segment) return `path segment is not a valid doc name: ${JSON.stringify(segment.slice(0, 40))}`
  }
  return null
}
