import { describe, expect, it } from "vitest"
import { SERIES_COUNT, seriesForGroupIndex, showsLabel, TYPE_SERIES, zoomBand } from "@/lib/chain-graph/presentation"

describe("zoomBand", () => {
  it("quantises to dot / label / full at 0.5 and 1.1", () => {
    expect(zoomBand(0.1)).toBe("dot")
    expect(zoomBand(0.499)).toBe("dot")
    expect(zoomBand(0.5)).toBe("label")
    expect(zoomBand(1.099)).toBe("label")
    expect(zoomBand(1.1)).toBe("full")
    expect(zoomBand(4)).toBe("full")
  })
})

describe("showsLabel", () => {
  it("shows key labels and clusters at the middle band, everything at full, nothing at dot", () => {
    expect(showsLabel("dot", "cluster")).toBe(false)
    expect(showsLabel("label", "cluster")).toBe(true)
    expect(showsLabel("label", "OBJECTIVE")).toBe(true)
    expect(showsLabel("label", "OPPORTUNITY")).toBe(true)
    expect(showsLabel("label", "EXPERIMENT")).toBe(false)
    expect(showsLabel("full", "EXPERIMENT")).toBe(true)
  })
})

describe("series mapping", () => {
  it("gives each type a distinct series slot", () => {
    expect(new Set(Object.values(TYPE_SERIES)).size).toBe(Object.keys(TYPE_SERIES).length)
  })
  it("cycles group colours by stable index, 1-based", () => {
    expect(seriesForGroupIndex(0)).toBe(1)
    expect(seriesForGroupIndex(SERIES_COUNT)).toBe(1)
    expect(seriesForGroupIndex(SERIES_COUNT + 2)).toBe(3)
    expect(seriesForGroupIndex(-1)).toBe(SERIES_COUNT)
  })
})
