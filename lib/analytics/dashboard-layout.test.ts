import { describe, expect, it } from "vitest"
import { clampLayout, dashboardLayoutInputSchema, dashboardSortOrderSchema, sizeBucket, SIZE_PRESET } from "./dashboard-layout"

describe("sizeBucket", () => {
  it.each([
    [1, 2, "sm"],
    [1, 1, "sm"],
    [2, 4, "md"],
    [1, 4, "md"],
    [2, 2, "md"],
    [3, 6, "lg"],
    [4, 6, "lg"],
    [2, 5, "lg"],
    [3, 2, "lg"],
  ] as const)("(%i,%i) buckets as %s", (col, row, expected) => {
    expect(sizeBucket(col, row)).toBe(expected)
  })
  it("round-trips every size preset", () => {
    for (const [bucket, { col, row }] of Object.entries(SIZE_PRESET)) {
      expect(sizeBucket(col, row)).toBe(bucket)
    }
  })
})

describe("clampLayout", () => {
  it("clamps below the minimum", () => {
    expect(clampLayout({ col: 0, row: 0 })).toEqual({ col: 1, row: 2 })
    expect(clampLayout({ col: -5, row: -5 })).toEqual({ col: 1, row: 2 })
  })
  it("clamps above the maximum", () => {
    expect(clampLayout({ col: 9, row: 9 })).toEqual({ col: 4, row: 6 })
  })
  it("rounds fractional drag deltas", () => {
    expect(clampLayout({ col: 2.4, row: 3.6 })).toEqual({ col: 2, row: 4 })
  })
  it("passes through valid in-range values", () => {
    expect(clampLayout({ col: 3, row: 5 })).toEqual({ col: 3, row: 5 })
  })
})

describe("dashboardLayoutInputSchema", () => {
  it("accepts finite col/row", () => {
    expect(dashboardLayoutInputSchema.parse({ col: 2, row: 4 })).toEqual({ col: 2, row: 4 })
  })
  it.each([
    { col: Infinity, row: 4 },
    { col: 2, row: NaN },
    { col: "2", row: 4 },
    { col: 2, row: 4, extra: true },
  ])("rejects %o", (input) => {
    expect(() => dashboardLayoutInputSchema.parse(input)).toThrow()
  })
})

describe("dashboardSortOrderSchema", () => {
  it("accepts integers, positive and negative", () => {
    expect(dashboardSortOrderSchema.parse(0)).toBe(0)
    expect(dashboardSortOrderSchema.parse(-3)).toBe(-3)
  })
  it("rejects non-integers", () => {
    expect(() => dashboardSortOrderSchema.parse(1.5)).toThrow()
  })
})
