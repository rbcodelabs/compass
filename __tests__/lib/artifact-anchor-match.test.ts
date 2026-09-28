import { describe, expect, it } from "vitest"
import {
  ELEMENT_ANCHOR_MATCH_THRESHOLD,
  pickBestMatch,
  resolveElementAnchor,
  scoreCandidate,
  textSimilarity,
} from "@/lib/artifact-anchor-match"

describe("textSimilarity", () => {
  it("is 1 for identical text and 0 when either side is empty", () => {
    expect(textSimilarity("Buy now", "Buy now")).toBe(1)
    expect(textSimilarity("Buy now", "")).toBe(0)
    expect(textSimilarity("", "Buy now")).toBe(0)
    expect(textSimilarity("", "")).toBe(1)
  })

  it("scores partial overlap between 0 and 1", () => {
    const score = textSimilarity("Buy now", "Buy later")
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it("is case-insensitive", () => {
    expect(textSimilarity("BUY NOW", "buy now")).toBe(1)
  })
})

describe("scoreCandidate", () => {
  it("scores an identical tag/text/position fingerprint at 1", () => {
    const target = { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 }
    expect(scoreCandidate(target, { ...target })).toBeCloseTo(1, 5)
  })

  it("penalises a tag mismatch even with identical text and position", () => {
    const target = { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 }
    const candidate = { tag: "a", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 }
    expect(scoreCandidate(target, candidate)).toBeCloseTo(0.3, 5)
  })

  it("decays with document-relative geometric distance", () => {
    const target = { tag: "button", rectXRatio: 0.1, rectYRatio: 0.1 }
    const near = scoreCandidate(target, { tag: "button", rectXRatio: 0.12, rectYRatio: 0.1 })
    const far = scoreCandidate(target, { tag: "button", rectXRatio: 0.9, rectYRatio: 0.9 })
    expect(near).toBeGreaterThan(far)
  })

  it("scores 0 when neither side has usable geometry or text", () => {
    expect(scoreCandidate({ tag: "button" }, { tag: "button" })).toBe(0)
  })
})

describe("pickBestMatch", () => {
  const target = { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 }
  const geometry = { left: 0, top: 0, width: 10, height: 10 }

  it("returns the best candidate above the threshold", () => {
    const candidates = [
      { fingerprint: { tag: "button", text: "Something else", rectXRatio: 0.9, rectYRatio: 0.9 }, geometry },
      { fingerprint: { tag: "button", text: "Buy now", rectXRatio: 0.21, rectYRatio: 0.3 }, geometry },
    ]
    const result = pickBestMatch(target, candidates)
    expect(result?.index).toBe(1)
    expect(result?.score).toBeGreaterThanOrEqual(ELEMENT_ANCHOR_MATCH_THRESHOLD)
  })

  it("returns null when nothing clears the threshold", () => {
    const candidates = [{ fingerprint: { tag: "a", text: "Unrelated copy entirely", rectXRatio: 0.95, rectYRatio: 0.95 }, geometry }]
    expect(pickBestMatch(target, candidates)).toBeNull()
  })

  it("returns null for an empty candidate list", () => {
    expect(pickBestMatch(target, [])).toBeNull()
  })
})

describe("resolveElementAnchor", () => {
  const fingerprint = { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3, rectWRatio: 0.1, rectHRatio: 0.05 }

  it("trusts a live selector match outright, without scoring", () => {
    const selectorGeometry = { left: 12, top: 34, width: 56, height: 78 }
    const result = resolveElementAnchor(fingerprint, selectorGeometry, null)
    expect(result).toEqual({ status: "anchored", source: "selector", confidence: 1, geometry: selectorGeometry })
  })

  it("falls back to a scored candidate match when the selector fails", () => {
    const geometry = { left: 5, top: 6, width: 7, height: 8 }
    const candidates = [{ fingerprint: { tag: "button", text: "Buy now", rectXRatio: 0.21, rectYRatio: 0.31 }, geometry }]
    const result = resolveElementAnchor(fingerprint, null, candidates)
    expect(result).toEqual({ status: "anchored", source: "fingerprint", confidence: expect.any(Number), geometry })
  })

  it("degrades to stale rather than positioning a pin at an unconfirmed spot", () => {
    const geometry = { left: 0, top: 0, width: 1, height: 1 }
    const candidates = [{ fingerprint: { tag: "a", text: "Totally unrelated", rectXRatio: 0.95, rectYRatio: 0.95 }, geometry }]
    expect(resolveElementAnchor(fingerprint, null, candidates)).toEqual({ status: "stale" })
    expect(resolveElementAnchor(fingerprint, null, [])).toEqual({ status: "stale" })
    expect(resolveElementAnchor(fingerprint, null, null)).toEqual({ status: "stale" })
  })

  it("reports unavailable when there is no fingerprint to work from at all", () => {
    expect(resolveElementAnchor(null, null, null)).toEqual({ status: "unavailable" })
    expect(resolveElementAnchor({ tag: "button" }, null, null)).toEqual({ status: "unavailable" })
  })
})
