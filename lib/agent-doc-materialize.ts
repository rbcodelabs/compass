/**
 * Which docs can be materialized into the sandbox such that the sandbox can
 * also read them back (ADR 0019 §2.4).
 *
 * The sandbox reads its tree through the geode wiki session, which has hard
 * limits: 10_000 entries, depth 32, notes over 2 MiB unreadable, 64 MiB of note
 * bytes in total, and a walk that skips dot-prefixed names and `node_modules`.
 * A doc past any of them would be written to disk but invisible (or unreadable)
 * when the final tree is read, and would then look deleted. So such docs are
 * kept OUT of the sandbox AND out of the baseline: the reconciler never learns
 * their ids, and so can never delete or overwrite them.
 */

import { MAX_DOC_DEPTH, isWikiExcludedSegment } from "@/lib/doc-path"

/** Wiki `maxNoteBytes` is 2 MiB; stay clear of it so frontmatter growth on read-back cannot cross it. */
export const SANDBOX_MAX_NOTE_BYTES = 2 * 1024 * 1024 - 16 * 1024
/** Wiki `maxTotalNoteBytes` is 64 MiB. */
export const SANDBOX_MAX_TOTAL_BYTES = 60 * 1024 * 1024
/** Wiki `maxEntries` is 10_000 and each doc is a directory plus a file. */
export const SANDBOX_MAX_DOCS = 4_900

export type ExcludedDoc = { path: string; reason: "depth" | "excluded-name" | "too-large" | "budget" }

export function selectMaterializable<T extends { path: string; content: string }>(
  entries: readonly T[]
): { included: T[]; excluded: ExcludedDoc[] } {
  const included: T[] = []
  const excluded: ExcludedDoc[] = []
  let totalBytes = 0
  for (const entry of entries) {
    const segments = entry.path.split("/")
    if (segments.length > MAX_DOC_DEPTH) { excluded.push({ path: entry.path, reason: "depth" }); continue }
    if (segments.some(isWikiExcludedSegment)) { excluded.push({ path: entry.path, reason: "excluded-name" }); continue }
    const bytes = Buffer.byteLength(entry.content, "utf8")
    if (bytes > SANDBOX_MAX_NOTE_BYTES) { excluded.push({ path: entry.path, reason: "too-large" }); continue }
    if (included.length >= SANDBOX_MAX_DOCS || totalBytes + bytes > SANDBOX_MAX_TOTAL_BYTES) { excluded.push({ path: entry.path, reason: "budget" }); continue }
    totalBytes += bytes
    included.push(entry)
  }
  return { included, excluded }
}
