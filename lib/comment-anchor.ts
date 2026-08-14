/**
 * Pure, DOM-free anchor resolution for inline doc comments.
 *
 * A comment's anchor is captured at creation time against the editor's
 * plain-text projection (NOT the markdown), storing the exact selected text,
 * the surrounding prefix/suffix context, and the start/end offsets. The
 * markdown content itself is never touched.
 *
 * At render time the anchor has to be re-located in the *current* plain-text
 * projection, which may have drifted as the doc was edited. This module does
 * that re-location. It is deliberately kept free of any TipTap/ProseMirror or
 * DOM dependency so it can be unit-tested directly (see
 * __tests__/lib/comment-anchor-resolution.test.ts). The extension that turns a
 * resolved plain-text range into a ProseMirror decoration lives separately in
 * components/docs/comment-highlight-extension.ts.
 */

import diff_match_patch from "diff-match-patch"

/** The stored anchor fields for a comment (all four offsets/text nullable — a
 * doc-level general comment omits them entirely). */
export interface CommentAnchor {
  anchorText: string | null
  anchorStart: number | null
  anchorEnd: number | null
  anchorPrefix?: string | null
  anchorSuffix?: string | null
}

/** A resolved range in *plain-text projection* coordinates (half-open: the
 * character span is [from, to)). */
export interface ResolvedAnchorRange {
  from: number
  to: number
}

// diff-match-patch's bitap matcher packs the pattern into a bitmask and refuses
// (throws) on patterns longer than this. We search on a capped slice and then
// expand back out to the anchor's full recorded length.
const MATCH_MAX_BITS = 32

// Fuzziness knobs. Threshold 0 = only exact matches count; 1 = anything within
// distance counts. 0.4 tolerates the light drift of a few edited characters
// inside/around the anchor without matching unrelated text. Distance bounds how
// far from the seed location a match may be found before its score is penalised.
const MATCH_THRESHOLD = 0.4
const MATCH_DISTANCE = 1000

/**
 * Does this anchor point at a specific span of text (vs. being a doc-level
 * general comment with no anchor)?
 */
export function hasTextAnchor(anchor: CommentAnchor): boolean {
  return typeof anchor.anchorText === "string" && anchor.anchorText.length > 0
}

/**
 * Locate a comment's anchor in the current plain-text projection.
 *
 * Returns the resolved half-open range, or null when the anchor can no longer
 * be confidently found (the text was deleted/rewritten) — the caller treats a
 * null as an "orphaned" comment: still listed and resolvable, just not
 * highlighted.
 *
 * Doc-level comments (no anchorText) always return null here; they are not a
 * failure, they simply have nothing to highlight.
 */
export function resolveCommentAnchor(
  text: string,
  anchor: CommentAnchor
): ResolvedAnchorRange | null {
  if (!hasTextAnchor(anchor)) return null

  const anchorText = anchor.anchorText as string
  const seed = clamp(anchor.anchorStart ?? 0, 0, text.length)

  // Fast path: the anchor is still sitting exactly where it was recorded (no
  // upstream edits shifted it). No fuzzy search, no length limit.
  if (text.substring(seed, seed + anchorText.length) === anchorText) {
    return { from: seed, to: seed + anchorText.length }
  }

  // Fuzzy path: the anchor may have shifted (e.g. text was inserted earlier in
  // the doc) or drifted slightly. match_main returns the best start index near
  // the seed, or -1 for no confident match. Cap the search pattern at
  // MATCH_MAX_BITS since bitap throws on longer patterns.
  const dmp = new diff_match_patch()
  dmp.Match_Threshold = MATCH_THRESHOLD
  dmp.Match_Distance = MATCH_DISTANCE

  const pattern =
    anchorText.length > MATCH_MAX_BITS ? anchorText.slice(0, MATCH_MAX_BITS) : anchorText

  const matchStart = dmp.match_main(text, pattern, seed)
  if (matchStart === -1) return null

  // Expand from the matched start back to the anchor's full recorded length,
  // clamped to the document. If the tail drifted the highlight may cover a
  // slightly different span, but it stays anchored to the right place.
  const to = clamp(matchStart + anchorText.length, matchStart, text.length)
  if (to <= matchStart) return null
  return { from: matchStart, to }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
