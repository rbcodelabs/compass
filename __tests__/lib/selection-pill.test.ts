import { describe, expect, it } from "vitest"
import { PILL_HEIGHT, PILL_HALF_WIDTH, pillPosition, similarQuery } from "@/lib/selection-pill"

const viewport = { width: 1000, height: 800 }
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

describe("pillPosition", () => {
  it("centres above the selection", () => {
    expect(pillPosition(box(400, 300, 600, 320), viewport)).toEqual({ left: 500, top: 300 - PILL_HEIGHT - 8 })
  })
  it("flips below when there is no room above", () => {
    expect(pillPosition(box(400, 10, 600, 30), viewport).top).toBe(38)
  })
  it("clamps horizontally to the viewport", () => {
    expect(pillPosition(box(0, 300, 20, 320), viewport).left).toBe(PILL_HALF_WIDTH + 8)
    expect(pillPosition(box(990, 300, 1000, 320), viewport).left).toBe(1000 - PILL_HALF_WIDTH - 8)
  })
  it("clamps vertically when the selection is at the very bottom and flips", () => {
    const { top } = pillPosition(box(400, 790, 600, 800), { width: 1000, height: 800 })
    expect(top).toBeLessThanOrEqual(800 - PILL_HEIGHT - 8)
  })
  it("survives a viewport narrower than the pill", () => {
    const { left } = pillPosition(box(0, 300, 50, 320), { width: 120, height: 800 })
    expect(Number.isFinite(left)).toBe(true)
  })
})

describe("similarQuery", () => {
  it("collapses whitespace", () => {
    expect(similarQuery("  a\n b\t c ")).toBe("a b c")
  })
  it("cuts long text at a word boundary within the limit", () => {
    const text = "word ".repeat(40)
    const q = similarQuery(text)
    expect(q.length).toBeLessThanOrEqual(100)
    expect(q.endsWith("word")).toBe(true)
  })
  it("hard-cuts a single long token", () => {
    expect(similarQuery("x".repeat(300))).toHaveLength(100)
  })
})
