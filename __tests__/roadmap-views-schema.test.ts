import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS, MAX_FILTER_IDS, countActiveFilters, hasExplicitRoadmapParams,
  makeRoadmapFieldKey, parseRoadmapFieldKey, parseRoadmapParams, parseStoredDisplay, parseStoredFilters, roadmapStateKey, roadmapStateToParams,
  roadmapViewFiltersSchema, roadmapViewInputSchema, type RoadmapViewDisplay, type RoadmapViewFilters,
} from "@/lib/roadmap-views/schema"

const W1 = "11111111-1111-4111-8111-111111111111"
const W2 = "22222222-2222-4222-8222-222222222222"
const S1 = "33333333-3333-4333-8333-333333333333"

const full: { filters: RoadmapViewFilters; display: RoadmapViewDisplay } = {
  filters: {
    workspaceIds: [W1, W2], horizons: ["NOW", "NEXT"], squadIds: [S1], deliveryStatuses: ["BLOCKED"],
    dateFrom: "2026-01-01", dateTo: "2026-06-30", keyResult: "linked", solution: "unlinked",
    fields: [{ key: "SELECT:status", values: ["At risk", "On, track~ing"] }],
  },
  display: { view: "table", groupBy: "workspace", sort: "startDate", fields: ["SELECT:status", "TEXT:owner, lead"], groupByField: "SELECT:status" },
}

describe("roadmap view filter schema", () => {
  it("defaults an empty document", () => {
    expect(roadmapViewFiltersSchema.parse({})).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(DEFAULT_ROADMAP_FILTERS.workspaceIds).toEqual([])
    expect(DEFAULT_ROADMAP_DISPLAY).toEqual({ view: "board", groupBy: "horizon", sort: "manual", fields: [] })
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
    expect(countActiveFilters(full.filters)).toBe(8)
    expect(countActiveFilters({ ...DEFAULT_ROADMAP_FILTERS, dateFrom: "2026-01-01" })).toBe(1)
  })
})

describe("display.columnLayout (pinned columns)", () => {
  const layout = { columnOrder: ["NEXT", "NOW", "unscheduled"], pinnedColumnIds: ["NEXT"], activePinnedId: "NEXT", dockCollapsed: false }

  it("is absent by default, so an untouched board adds nothing to a saved view", () => {
    expect(DEFAULT_ROADMAP_DISPLAY.columnLayout).toBeUndefined()
    expect(parseStoredDisplay({}).columnLayout).toBeUndefined()
  })

  it("round-trips a valid layout through the display parse and the create/update input schema", () => {
    expect(parseStoredDisplay({ sort: "title", columnLayout: layout })).toMatchObject({ sort: "title", columnLayout: layout })
    const input = roadmapViewInputSchema.parse({ name: "v", filters: {}, display: { columnLayout: layout } })
    expect(input.display.columnLayout).toEqual(layout)
  })

  it("an older-shape layout (per-column collapsedColumnIds) still parses; the stale field is dropped", () => {
    const old = { columnOrder: ["NOW"], pinnedColumnIds: ["NOW"], collapsedColumnIds: ["NOW"] }
    expect(parseStoredDisplay({ sort: "title", columnLayout: old })).toMatchObject({ sort: "title", columnLayout: { columnOrder: ["NOW"], pinnedColumnIds: ["NOW"] } })
    expect(parseStoredDisplay({ columnLayout: old }).columnLayout).not.toHaveProperty("collapsedColumnIds")
  })

  it("a layout that does not validate degrades to absent WITHOUT discarding the rest of the display document", () => {
    for (const bad of ["junk", 7, [], {}, { columnOrder: "NOW", pinnedColumnIds: [] }, { columnOrder: [1], pinnedColumnIds: [] }]) {
      const parsed = parseStoredDisplay({ view: "timeline", groupBy: "squad", sort: "title", columnLayout: bad })
      expect(parsed).toMatchObject({ view: "timeline", groupBy: "squad", sort: "title" })
      expect(parsed.columnLayout).toBeUndefined()
    }
  })

  it("a write payload with a bad layout is accepted with the layout dropped, never rejected", () => {
    const input = roadmapViewInputSchema.safeParse({ name: "v", filters: {}, display: { sort: "title", columnLayout: { nope: true } } })
    expect(input.success).toBe(true)
    expect(input.success && input.data.display).toMatchObject({ sort: "title" })
    expect(input.success && input.data.display.columnLayout).toBeUndefined()
  })

  it("other invalid display fields still fall back to the whole default (unchanged behaviour)", () => {
    expect(parseStoredDisplay({ sort: "bogus", columnLayout: layout })).toEqual(DEFAULT_ROADMAP_DISPLAY)
  })

  it("is part of the state key (so 'modified' sees it) but not of the URL", () => {
    const withLayout = { ...full, display: { ...full.display, columnLayout: layout } }
    expect(roadmapStateKey(withLayout)).not.toBe(roadmapStateKey(full))
    expect(roadmapStateKey({ ...withLayout, display: { ...withLayout.display, columnLayout: { ...layout, pinnedColumnIds: [...layout.pinnedColumnIds] } } })).toBe(roadmapStateKey(withLayout))
    expect(roadmapStateToParams(withLayout).toString()).toBe(roadmapStateToParams(full).toString())
  })
})

describe("cross-workspace field keys", () => {
  it("builds a case-insensitive type + name key and parses it back", () => {
    expect(makeRoadmapFieldKey("SELECT", "  Status ")).toBe("SELECT:status")
    expect(parseRoadmapFieldKey("SELECT:status")).toEqual({ fieldType: "SELECT", name: "status" })
    expect(parseRoadmapFieldKey("NOPE:status")).toBeNull()
    expect(parseRoadmapFieldKey("SELECT:")).toBeNull()
    // Same name, different type, is a different field.
    expect(makeRoadmapFieldKey("TEXT", "Status")).not.toBe(makeRoadmapFieldKey("SELECT", "Status"))
  })

  it("only lets picklist keys be filtered or grouped on", () => {
    expect(roadmapViewFiltersSchema.safeParse({ fields: [{ key: "TEXT:owner", values: ["x"] }] }).success).toBe(false)
    expect(roadmapViewFiltersSchema.safeParse({ fields: [{ key: "MULTI_SELECT:team", values: ["x"] }] }).success).toBe(true)
    expect(roadmapViewInputSchema.safeParse({ name: "v", filters: {}, display: { groupByField: "TEXT:owner" } }).success).toBe(false)
    expect(roadmapViewInputSchema.safeParse({ name: "v", filters: {}, display: { fields: ["TEXT:owner", "SELECT:status"] } }).success).toBe(true)
  })

  it("keeps commas and tildes inside names and labels intact through the URL", () => {
    const params = Object.fromEntries(roadmapStateToParams(full))
    const back = parseRoadmapParams(params)
    expect(back.filters.fields).toEqual(full.filters.fields)
    expect(back.display.fields).toEqual(["SELECT:status", "TEXT:owner, lead"])
    expect(back.display.groupByField).toBe("SELECT:status")
  })

  it("drops invalid field tokens individually", () => {
    const { filters, display } = parseRoadmapParams({ fields: "SELECT:status,BOGUS:x", ff: "TEXT:owner~a,SELECT:status~Done", groupByField: "TEXT:owner" })
    expect(display.fields).toEqual(["SELECT:status"])
    expect(filters.fields).toEqual([{ key: "SELECT:status", values: ["Done"] }])
    expect(display.groupByField).toBeUndefined()
  })

  it("field order is part of the state key; filter order is not", () => {
    const a = { ...full, display: { ...full.display, fields: ["SELECT:status", "SELECT:team"] } }
    const b = { ...full, display: { ...full.display, fields: ["SELECT:team", "SELECT:status"] } }
    expect(roadmapStateKey(a)).not.toBe(roadmapStateKey(b))
    const f1 = { ...full, filters: { ...full.filters, fields: [{ key: "SELECT:a", values: ["x", "y"] }, { key: "SELECT:b", values: ["z"] }] } }
    const f2 = { ...full, filters: { ...full.filters, fields: [{ key: "SELECT:b", values: ["z"] }, { key: "SELECT:a", values: ["y", "x"] }] } }
    expect(roadmapStateKey(f1)).toBe(roadmapStateKey(f2))
  })
})

describe("backward compatibility: saved views stored before field-driven views", () => {
  // Literal documents in the shape persisted before `fields` / `groupByField` / the table layout existed.
  const oldFilters = {
    workspaceIds: [W1], horizons: ["NOW"], squadIds: [S1], deliveryStatuses: ["BLOCKED"],
    dateFrom: "2026-01-01", dateTo: "2026-06-30", keyResult: "linked", solution: "unlinked",
  }
  const oldDisplay = { view: "timeline", groupBy: "squad", sort: "title" }

  it("an old-shape filters document parses with every stored value unchanged and no field filters", () => {
    expect(parseStoredFilters(oldFilters)).toEqual({ ...oldFilters, fields: [] })
    expect(parseStoredFilters({})).toEqual(DEFAULT_ROADMAP_FILTERS)
    expect(DEFAULT_ROADMAP_FILTERS.fields).toEqual([])
  })

  it("an old-shape display document parses with every stored value unchanged and no shown or grouping field", () => {
    const parsed = parseStoredDisplay(oldDisplay)
    expect(parsed).toEqual({ ...oldDisplay, fields: [] })
    expect(parsed.groupByField).toBeUndefined()
  })

  it("old-shape display documents with the pre-existing options (workspace groupField, gallery, status) still validate", () => {
    const groupField = "44444444-4444-4444-8444-444444444444"
    expect(parseStoredDisplay({ view: "gallery", groupBy: "status", sort: "manual", groupField })).toMatchObject({ view: "gallery", groupBy: "status", groupField, fields: [] })
  })

  it("an old-shape view yields the same URL as before: the new params are omitted", () => {
    const state = { filters: parseStoredFilters(oldFilters), display: parseStoredDisplay(oldDisplay) }
    const params = roadmapStateToParams(state)
    expect([...params.keys()].sort()).toEqual(["from", "groupBy", "horizons", "kr", "solution", "sort", "squads", "statuses", "to", "view", "workspaces"].sort())
    for (const added of ["ff", "fields", "groupByField"]) expect(params.has(added)).toBe(false)
  })

  it("an old-shape view round-trips through the URL and is not reported as modified", () => {
    const state = { filters: parseStoredFilters(oldFilters), display: parseStoredDisplay(oldDisplay) }
    const back = parseRoadmapParams(Object.fromEntries(roadmapStateToParams(state)))
    expect(roadmapStateKey(back)).toBe(roadmapStateKey(state))
    expect(back.filters.fields).toEqual([])
    expect(back.display.fields).toEqual([])
  })

  it("an old-shape view counts the same active filters as before", () => {
    expect(countActiveFilters(parseStoredFilters(oldFilters))).toBe(7)
  })

  it("an old-shape payload is still accepted by the create/update schema", () => {
    expect(roadmapViewInputSchema.safeParse({ name: "Legacy", visibility: "SHARED", filters: oldFilters, display: oldDisplay }).success).toBe(true)
  })
})
