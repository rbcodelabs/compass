import { describe, expect, it } from "vitest"
import { estimateLabelSize, labelTier, LABEL_TIER, resolveLabelCollisions, type LabelCandidate } from "@/lib/chain-graph/label-collision"

const box = (key: string, x: number, y: number, tier: number = LABEL_TIER.rest, extra: Partial<LabelCandidate> = {}): LabelCandidate => ({
  key,
  tier,
  alwaysShow: false,
  x,
  y,
  width: 100,
  height: 20,
  ...extra,
})

describe("resolveLabelCollisions", () => {
  it("keeps every label when none overlap", () => {
    const shown = resolveLabelCollisions([box("a", 0, 0), box("b", 200, 0), box("c", 0, 100)])
    expect([...shown].sort()).toEqual(["a", "b", "c"])
  })

  it("drops the lower-priority label of an overlapping pair", () => {
    const shown = resolveLabelCollisions([box("low", 0, 0, LABEL_TIER.rest), box("high", 50, 5, LABEL_TIER.key)])
    expect([...shown]).toEqual(["high"])
  })

  it("is independent of input order and breaks ties by key", () => {
    const items = [box("b", 0, 0), box("a", 40, 0), box("c", 300, 0)]
    const forward = [...resolveLabelCollisions(items)].sort()
    const reversed = [...resolveLabelCollisions([...items].reverse())].sort()
    expect(forward).toEqual(["a", "c"])
    expect(reversed).toEqual(forward)
  })

  it("treats labels closer than the gap as colliding", () => {
    expect(resolveLabelCollisions([box("a", 0, 0), box("b", 101, 0)]).size).toBe(1)
    expect(resolveLabelCollisions([box("a", 0, 0), box("b", 110, 0)]).size).toBe(2)
  })

  it("always shows the always-show set even when they collide with each other", () => {
    const shown = resolveLabelCollisions([
      box("sel", 0, 0, LABEL_TIER.selected, { alwaysShow: true }),
      box("trace", 30, 0, LABEL_TIER.traced, { alwaysShow: true }),
      box("other", 60, 0, LABEL_TIER.key),
    ])
    expect([...shown].sort()).toEqual(["sel", "trace"])
  })

  it("lets a lower tier yield to an always-show label even if it was listed first", () => {
    const shown = resolveLabelCollisions([box("rest", 0, 0, LABEL_TIER.rest), box("sel", 10, 0, LABEL_TIER.selected, { alwaysShow: true })])
    expect([...shown]).toEqual(["sel"])
  })

  it("finds collisions across grid cell boundaries", () => {
    const shown = resolveLabelCollisions([box("a", 100, 0, LABEL_TIER.key), box("b", 190, 0, LABEL_TIER.rest)])
    expect([...shown]).toEqual(["a"])
  })

  it("produces no overlapping pair in a dense field", () => {
    const items: LabelCandidate[] = []
    for (let i = 0; i < 200; i++) items.push(box(`n${String(i).padStart(3, "0")}`, (i * 37) % 400, (i * 53) % 300, i % 7))
    const shown = resolveLabelCollisions(items)
    const kept = items.filter((c) => shown.has(c.key))
    for (let i = 0; i < kept.length; i++)
      for (let j = i + 1; j < kept.length; j++) {
        const a = kept[i]
        const b = kept[j]
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        expect(apart).toBe(true)
      }
  })
})

describe("labelTier", () => {
  const none = { selected: false, hovered: false, traced: false, matched: false, pinned: false, keyType: false }
  it("orders selected, hovered, traced, match, pinned, key, rest", () => {
    expect(labelTier({ ...none, selected: true, hovered: true, traced: true })).toBe(LABEL_TIER.selected)
    expect(labelTier({ ...none, hovered: true, traced: true })).toBe(LABEL_TIER.hovered)
    expect(labelTier({ ...none, traced: true, matched: true })).toBe(LABEL_TIER.traced)
    expect(labelTier({ ...none, matched: true, pinned: true })).toBe(LABEL_TIER.match)
    expect(labelTier({ ...none, pinned: true, keyType: true })).toBe(LABEL_TIER.pinned)
    expect(labelTier({ ...none, keyType: true })).toBe(LABEL_TIER.key)
    expect(labelTier(none)).toBe(LABEL_TIER.rest)
  })
})

describe("estimateLabelSize", () => {
  it("caps the text width and adds a detail line only when asked", () => {
    const long = "x".repeat(200)
    expect(estimateLabelSize(long, null).width).toBe(208)
    expect(estimateLabelSize("Hi", null).height).toBeLessThan(estimateLabelSize("Hi", "Solution · Draft").height)
  })
})
