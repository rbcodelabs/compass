import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS, MAX_FILTER_IDS, countActiveFilters, hasExplicitRoadmapParams,
  parseRoadmapParams, parseStoredDisplay, parseStoredFilters, roadmapStateKey, roadmapStateToParams,
  roadmapViewFiltersSchema, roadmapViewInputSchema, type RoadmapViewDisplay, type RoadmapViewFilters,
} from "@/lib/roadmap-views/schema"

const W1 = "11111111-1111-4111-8111-111111111111"
const W2 = "22222222-2222-4222-8222-222222222222"
const S1 = "33333333-3333-4333-8333-333333333333"

const full: { filters: RoadmapViewFilters; display: RoadmapViewDisplay } = {
  filters: {
    workspaceIds: [W1, W2], horizons: ["NOW", "NEXT"], squadIds: [S1], deliveryStatuses: ["BLOCKED"],
    dateFrom: "2026-01-01", dateTo: "2026-06-30", keyResult: "linked", solution: "unlinked",
  },
  display: { view: "timeline", groupBy: "workspace", sort: "startDate" },
}

describe("roadmap view filter schema", () => {
  it("defaults an empty document", () => {
    expect(roadmapViewFiltersSchema.parse({})).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(DEFAULT_ROADMAP_FILTERS.workspaceIds).toEqual([])
    expect(DEFAULT_ROADMAP_DISPLAY).toEqual({ view: "board", groupBy: "horizon", sort: "manual" })
  })

  it("rejects bad ids, unknown enums, bad dates and reversed ranges", () => {
    expect(roadmapViewFiltersSchema.safeParse({ workspaceIds: ["nope"] }).success).toBe(false)
    expect(roadmapViewFiltersSchema.safeParse({ horizons: ["SOMEDAY"] }).success).toBe(false)
    expect(roadmapViewFiltersSchema.safeParse({ dateFrom: "2026-13-45" }).success).toBe(false)
    expect(roadmapViewFiltersSchema.safeParse({ dateFrom: "01/02/2026" }).success).toBe(false)
    expect(roadmapViewFiltersSchema.safeParse({ dateFrom: "2026-05-01", dateTo: "2026-04-01" }).success).toBe(false)
    expect(roadmapViewFiltersSchema.safeParse({ dateFrom: "2026-05-01", dateTo: "2026-05-01" }).success).toBe(true)
  })

  it("bounds id lists", () => {
    const ids = Array.from({ length: MAX_FILTER_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)
    expect(roadmapViewFiltersSchema.safeParse({ squadIds: ids }).success).toBe(false)
  })

  it("validates the create/update payload", () => {
    const ok = roadmapViewInputSchema.parse({ name: "  Q3  ", filters: {}, display: {} })
    expect(ok.name).toBe("Q3")
    expect(ok.visibility).toBe("PERSONAL")
    expect(roadmapViewInputSchema.safeParse({ name: "   ", filters: {}, display: {} }).success).toBe(false)
    expect(roadmapViewInputSchema.safeParse({ name: "x".repeat(121), filters: {}, display: {} }).success).toBe(false)
    expect(roadmapViewInputSchema.safeParse({ name: "x", visibility: "PUBLIC", filters: {}, display: {} }).success).toBe(false)
  })

  it("read-side parsers never throw and degrade to defaults", () => {
    expect(parseStoredFilters(null)).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(parseStoredFilters({ horizons: ["REMOVED_HORIZON"] })).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(parseStoredFilters("garbage")).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(parseStoredDisplay({ view: "kanban" })).toEqual(DEFAULT_ROADMAP_DISPLAY)
    expect(parseStoredDisplay(undefined)).toEqual(DEFAULT_ROADMAP_DISPLAY)
    expect(parseStoredFilters(full.filters)).toEqual(full.filters)
  })
})

describe("roadmap view URL round-trip", () => {
  it("omits defaults so a bare roadmap has a bare URL", () => {
    expect(roadmapStateToParams({ filters: DEFAULT_ROADMAP_FILTERS, display: DEFAULT_ROADMAP_DISPLAY }).toString()).toBe("")
  })

  it("round-trips a fully populated state", () => {
    const params = Object.fromEntries(roadmapStateToParams(full))
    expect(parseRoadmapParams(params)).toEqual(full)
  })

  it("drops invalid tokens individually and keeps the rest", () => {
    const { filters, display } = parseRoadmapParams({
      workspaces: `${W1},not-a-uuid`, horizons: "NOW,BOGUS", statuses: "BLOCKED,NOPE", kr: "maybe", view: "kanban", sort: "title",
    })
    expect(filters.workspaceIds).toEqual([W1])
    expect(filters.horizons).toEqual(["NOW"])
    expect(filters.deliveryStatuses).toEqual(["BLOCKED"])
    expect(filters.keyResult).toBeUndefined()
    expect(display.view).toBe("board")
    expect(display.sort).toBe("title")
  })

  it("drops a reversed date range's upper bound", () => {
    const { filters } = parseRoadmapParams({ from: "2026-05-01", to: "2026-04-01" })
    expect(filters.dateFrom).toBe("2026-05-01")
    expect(filters.dateTo).toBeUndefined()
  })

  it("explicit params override the saved view base; untouched keys keep the base", () => {
    const { filters, display } = parseRoadmapParams({ horizons: "LATER", sort: "title" }, full)
    expect(filters.horizons).toEqual(["LATER"])
    expect(filters.workspaceIds).toEqual(full.filters.workspaceIds)
    expect(display.groupBy).toBe("workspace")
    expect(display.sort).toBe("title")
  })

  it("an explicitly empty param does not clear the base (empty string is treated as absent)", () => {
    const { filters } = parseRoadmapParams({ horizons: "" }, full)
    expect(filters.horizons).toEqual(["NOW", "NEXT"])
  })

  it("hasExplicitRoadmapParams ignores the saved-view selector", () => {
    expect(hasExplicitRoadmapParams({ saved: W1 })).toBe(false)
    expect(hasExplicitRoadmapParams({ horizons: "NOW" })).toBe(true)
    expect(hasExplicitRoadmapParams({ sort: ["title"] })).toBe(true)
  })

  it("state key is order-insensitive but value-sensitive", () => {
    const reordered = { ...full, filters: { ...full.filters, workspaceIds: [W2, W1], horizons: ["NEXT", "NOW"] as RoadmapViewFilters["horizons"] } }
    expect(roadmapStateKey(reordered)).toBe(roadmapStateKey(full))
    expect(roadmapStateKey({ ...full, display: { ...full.display, sort: "title" } })).not.toBe(roadmapStateKey(full))
  })

  it("counts active filters; a date range is one filter and display options are none", () => {
    expect(countActiveFilters(DEFAULT_ROADMAP_FILTERS)).toBe(0)
    expect(countActiveFilters(full.filters)).toBe(7)
    expect(countActiveFilters({ ...DEFAULT_ROADMAP_FILTERS, dateFrom: "2026-01-01" })).toBe(1)
  })
})
