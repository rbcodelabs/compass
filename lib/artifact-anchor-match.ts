/**
 * Pure, DOM-free re-anchoring for element-anchored Artifact comments.
 *
 * The sandboxed iframe (components/artifact-sandboxed-frame.tsx /
 * lib/artifact-preview-html.ts's injected script) is the only thing with
 * access to the uploaded prototype's live DOM, so it does the *collecting*:
 * it tries a stored anchor's `elementSelector` first and, if that no longer
 * resolves, gathers same-tag candidate elements' geometry/text. It never
 * decides what counts as a good enough match — that decision lives here, in
 * ordinary TypeScript, so it can be unit-tested directly instead of living
 * only as untestable injected JS (see the module doc on
 * `injectArtifactPreviewHandshake`).
 *
 * Philosophy ported from `lib/comment-anchor.ts` (DocCommentAnchor's
 * text-based re-anchoring): try the exact/live match first, fall back to a
 * scored candidate search, and when nothing clears the confidence threshold,
 * report "stale" rather than ever positioning a pin at an unconfirmed spot.
 */

export type ElementFingerprint = {
  tag?: string
  text?: string
  rectXRatio?: number
  rectYRatio?: number
  rectWRatio?: number
  rectHRatio?: number
}

/**
 * Where a live element sits in the sandboxed iframe's OWN viewport right
 * now, in CSS pixels. Never persisted — only `ElementFingerprint`'s
 * document-relative ratios go in the database. This is what the parent
 * overlay adds to the iframe element's own `getBoundingClientRect()` to
 * absolute-position a pin over the (opaque-origin, cross-frame) content.
 */
export type LiveElementGeometry = {
  left: number
  top: number
  width: number
  height: number
}

/**
 * A same-tag element the sandbox found while scanning for a fallback match.
 * `fingerprint`'s ratios are what scoring reads; `geometry` is carried along
 * so the winning candidate can be positioned without a second round trip.
 */
export type FingerprintCandidate = {
  fingerprint: ElementFingerprint
  geometry: LiveElementGeometry
}

export type AnchorResolution =
  | { status: "anchored"; source: "selector" | "fingerprint"; confidence: number; geometry: LiveElementGeometry }
  | { status: "stale" }
  | { status: "unavailable" }

/** Below this score a candidate is not a confident enough match to trust. */
export const ELEMENT_ANCHOR_MATCH_THRESHOLD = 0.5

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i < value.length - 1; i += 1) {
    const gram = value.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Dice's coefficient over character bigrams — cheap, deterministic, no dependency. */
export function textSimilarity(a: string, b: string): number {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left && !right) return 1
  if (!left || !right) return 0
  if (left === right) return 1
  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  let overlap = 0
  let leftTotal = 0
  let rightTotal = 0
  for (const [gram, count] of leftGrams) {
    leftTotal += count
    const rightCount = rightGrams.get(gram)
    if (rightCount) overlap += Math.min(count, rightCount)
  }
  for (const count of rightGrams.values()) rightTotal += count
  const total = leftTotal + rightTotal
  return total === 0 ? 0 : (2 * overlap) / total
}

/** 1 for identical document-relative position, decaying to 0 as it drifts. */
function geometryScore(target: ElementFingerprint, candidate: ElementFingerprint): number {
  if (
    !isFiniteNumber(target.rectXRatio) ||
    !isFiniteNumber(target.rectYRatio) ||
    !isFiniteNumber(candidate.rectXRatio) ||
    !isFiniteNumber(candidate.rectYRatio)
  ) {
    return 0
  }
  const dx = target.rectXRatio - candidate.rectXRatio
  const dy = target.rectYRatio - candidate.rectYRatio
  const distance = Math.sqrt(dx * dx + dy * dy)
  return Math.max(0, 1 - distance)
}

/**
 * Score one candidate against the stored fingerprint. A tag mismatch is
 * heavily (not fully) penalised rather than disqualifying outright — callers
 * that already filter candidates by tag (the injected sandbox script does)
 * never hit the penalty, but this stays correct for a candidate list that
 * has not been pre-filtered.
 */
export function scoreCandidate(target: ElementFingerprint, candidate: ElementFingerprint): number {
  const tagPenalty = target.tag && candidate.tag && target.tag !== candidate.tag ? 0.3 : 1
  const hasText = Boolean(target.text) || Boolean(candidate.text)
  const text = hasText ? textSimilarity(target.text ?? "", candidate.text ?? "") : 0
  const geometry = geometryScore(target, candidate)
  const textWeight = hasText ? 0.5 : 0
  const geometryWeight = 1 - textWeight
  return tagPenalty * (text * textWeight + geometry * geometryWeight)
}

/** The best-scoring candidate, or null if none clears the match threshold. */
export function pickBestMatch(
  target: ElementFingerprint,
  candidates: FingerprintCandidate[],
): { index: number; score: number } | null {
  let best: { index: number; score: number } | null = null
  for (let index = 0; index < candidates.length; index += 1) {
    const score = scoreCandidate(target, candidates[index].fingerprint)
    if (!best || score > best.score) best = { index, score }
  }
  if (!best || best.score < ELEMENT_ANCHOR_MATCH_THRESHOLD) return null
  return best
}

/**
 * Combine a live selector match (if any) and a candidate search (if the
 * selector failed) into one resolution. `selectorMatch` is always trusted
 * outright when present — a live selector hit is the ground truth, exactly
 * as the embed widget's `anchorViewportRect` already treats it (see
 * public/embed/widget.js). Only the *fallback* path is scored, and a
 * candidate that scores below threshold degrades the whole anchor to
 * "stale" rather than ever positioning a pin at an unconfirmed spot.
 */
export function resolveElementAnchor(
  fingerprint: ElementFingerprint | null | undefined,
  selectorMatch: LiveElementGeometry | null | undefined,
  candidates: FingerprintCandidate[] | null | undefined,
): AnchorResolution {
  if (selectorMatch) {
    return { status: "anchored", source: "selector", confidence: 1, geometry: selectorMatch }
  }
  if (!fingerprint || !isFiniteNumber(fingerprint.rectXRatio) || !isFiniteNumber(fingerprint.rectYRatio)) {
    return { status: "unavailable" }
  }
  const best = candidates && candidates.length > 0 ? pickBestMatch(fingerprint, candidates) : null
  if (best) {
    const candidate = candidates![best.index]
    return { status: "anchored", source: "fingerprint", confidence: best.score, geometry: candidate.geometry }
  }
  return { status: "stale" }
}
