import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS, resolveRoadmapState, roadmapHref,
  type RoadmapViewDisplay, type RoadmapViewFilters,
} from "@/lib/roadmap-views/schema"

const W1 = "11111111-1111-4111-8111-111111111111"
const VIEW_ID = "44444444-4444-4444-8444-444444444444"

const saved: { filters: RoadmapViewFilters; display: RoadmapViewDisplay } = {
  filters: { ...DEFAULT_ROADMAP_FILTERS, workspaceIds: [W1], horizons: ["NOW"] },
  display: { ...DEFAULT_ROADMAP_DISPLAY, view: "timeline" },
}

describe("resolveRoadmapState", () => {
  it("falls back to the defaults with no saved view", () => {
    expect(resolveRoadmapState({}, null)).toEqual({ filters: DEFAULT_ROADMAP_FILTERS, display: DEFAULT_ROADMAP_DISPLAY })
  })

  it("uses the saved view as the base", () => {
    expect(resolveRoadmapState({ saved: VIEW_ID }, saved)).toEqual(saved)
  })

  it("lets explicit params override the saved view", () => {
    const state = resolveRoadmapState({ saved: VIEW_ID, horizons: "NEXT" }, saved)
    expect(state.filters.horizons).toEqual(["NEXT"])
    expect(state.filters.workspaceIds).toEqual([W1])
    expect(state.display.view).toBe("timeline")
  })

  it("does not layer the saved view under an edited=1 URL, so a cleared filter stays cleared", () => {
    const state = resolveRoadmapState({ saved: VIEW_ID, edited: "1", view: "timeline" }, saved)
    expect(state.filters).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(state.display.view).toBe("timeline")
  })
})

describe("roadmapHref", () => {
  const base = "/acme/roadmap"

  it("is the bare path for the default state", () => {
    expect(roadmapHref(base, { filters: DEFAULT_ROADMAP_FILTERS, display: DEFAULT_ROADMAP_DISPLAY })).toBe(base)
  })

  it("serializes filters and display without a saved view", () => {
    expect(roadmapHref(base, saved)).toBe(`${base}?workspaces=${W1}&horizons=NOW&view=timeline`)
  })

  it("collapses to ?saved= when the state equals the saved view", () => {
    expect(roadmapHref(base, saved, { savedViewId: VIEW_ID, savedState: saved })).toBe(`${base}?saved=${VIEW_ID}`)
  })

  it("carries the full state plus edited=1 when it differs from the saved view", () => {
    const next = { ...saved, filters: { ...saved.filters, horizons: [] } }
    const href = roadmapHref(base, next, { savedViewId: VIEW_ID, savedState: saved })
    expect(href).toContain(`saved=${VIEW_ID}`)
    expect(href).toContain("edited=1")
    expect(href).not.toContain("horizons=")
  })

  it("round-trips: resolving the generated URL yields the same state, even for a cleared filter", () => {
    const next = { ...saved, filters: { ...saved.filters, horizons: [] } }
    const url = new URL(roadmapHref(base, next, { savedViewId: VIEW_ID, savedState: saved }), "http://x")
    const params = Object.fromEntries(url.searchParams)
    expect(resolveRoadmapState(params, saved)).toEqual(next)
  })
})
