/**
 * Unit tests for the pure comment-anchor resolver (lib/comment-anchor.ts).
 *
 * These exercise the match_main-based re-location logic directly against
 * plain-text strings — no DOM, no TipTap, no ProseMirror — covering the three
 * cases that matter for inline comments:
 *   1. exact match (anchor still sitting where it was recorded),
 *   2. shifted-offset match after an unrelated edit earlier in the doc,
 *   3. orphaned / no-match (the anchored text was deleted or rewritten).
 */
import { describe, it, expect } from "vitest"
import { resolveCommentAnchor, hasTextAnchor } from "@/lib/comment-anchor"

describe("hasTextAnchor", () => {
  it("is true for a comment anchored to specific text", () => {
    expect(hasTextAnchor({ anchorText: "brown fox", anchorStart: 10, anchorEnd: 19 })).toBe(true)
  })

  it("is false for a doc-level comment with no anchor text", () => {
    expect(hasTextAnchor({ anchorText: null, anchorStart: null, anchorEnd: null })).toBe(false)
    expect(hasTextAnchor({ anchorText: "", anchorStart: null, anchorEnd: null })).toBe(false)
  })
})

describe("resolveCommentAnchor — exact match", () => {
  it("resolves an anchor still sitting exactly where it was recorded", () => {
    const text = "The quick brown fox jumps over the lazy dog"
    // "brown fox" begins at index 10.
    const range = resolveCommentAnchor(text, {
      anchorText: "brown fox",
      anchorStart: 10,
      anchorEnd: 19,
    })
    expect(range).toEqual({ from: 10, to: 19 })
    expect(text.slice(range!.from, range!.to)).toBe("brown fox")
  })

  it("resolves a long (>32 char) anchor via the exact fast path without throwing", () => {
    const longAnchor = "the exceptionally long anchored selection here"
    const text = `Prefix words. ${longAnchor}. Trailing.`
    const start = text.indexOf(longAnchor)
    const range = resolveCommentAnchor(text, {
      anchorText: longAnchor,
      anchorStart: start,
      anchorEnd: start + longAnchor.length,
    })
    expect(range).toEqual({ from: start, to: start + longAnchor.length })
  })
})

describe("resolveCommentAnchor — shifted offset after an unrelated earlier edit", () => {
  it("relocates the anchor when text was inserted earlier in the doc", () => {
    const anchorText = "brown fox"
    const original = "Intro line. The quick brown fox."
    const originalStart = original.indexOf(anchorText) // 22

    // Someone prepends a new sentence — every later offset shifts right.
    const prefix = "A new first sentence. "
    const current = prefix + original
    const expectedStart = current.indexOf(anchorText)
    expect(expectedStart).not.toBe(originalStart) // sanity: it really moved

    const range = resolveCommentAnchor(current, {
      anchorText,
      anchorStart: originalStart, // stale seed
      anchorEnd: originalStart + anchorText.length,
    })
    expect(range).toEqual({ from: expectedStart, to: expectedStart + anchorText.length })
    expect(current.slice(range!.from, range!.to)).toBe(anchorText)
  })

  it("relocates a long (>32 char) anchor via the capped fuzzy pattern after a shift", () => {
    const anchorText = "the exceptionally long anchored selection here"
    const original = `Lead in. ${anchorText}. Tail.`
    const originalStart = original.indexOf(anchorText)
    const current = "Freshly inserted opening paragraph. " + original
    const expectedStart = current.indexOf(anchorText)

    const range = resolveCommentAnchor(current, {
      anchorText,
      anchorStart: originalStart,
      anchorEnd: originalStart + anchorText.length,
    })
    expect(range).toEqual({ from: expectedStart, to: expectedStart + anchorText.length })
  })
})

describe("resolveCommentAnchor — orphaned / no match", () => {
  it("returns null when the anchored text has been deleted/rewritten", () => {
    const range = resolveCommentAnchor("XYZ 123 ABC 456 QWERTY UIOP ZZZZ 789.", {
      anchorText: "brown fox",
      anchorStart: 22,
      anchorEnd: 31,
    })
    expect(range).toBeNull()
  })

  it("returns null for a doc-level comment with no anchor", () => {
    const range = resolveCommentAnchor("Any content at all", {
      anchorText: null,
      anchorStart: null,
      anchorEnd: null,
    })
    expect(range).toBeNull()
  })
})
