import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPPORTUNITIES_STATE, isOpportunitiesStateModified, needsSavedViewExpansion, normalizeOpportunitiesState,
  normalizeStatusLayout, opportunitiesHref, opportunitiesPageParams, opportunitiesStateKey, opportunitiesStateToParams,
  resolveSurfaceState, type OpportunitiesState,
} from "@/lib/saved-views/opportunities-state"
import { resolveOpportunityColumns } from "@/lib/saved-views/opportunity-columns"
import { parseStoredDisplayFor, savedViewInputSchemaFor } from "@/lib/saved-views/schema"

const SQUAD = "11111111-1111-4111-8111-111111111111"
const SQUAD_2 = "22222222-2222-4222-8222-222222222222"
const FIELD = "33333333-3333-4333-8333-333333333333"

const resolve = (params: Record<string, string>, saved: OpportunitiesState | null = null) =>
  resolveSurfaceState("OPPORTUNITIES_BOARD", params, saved)

function savedState(over: Partial<OpportunitiesState["filters"]> = {}, display: Partial<OpportunitiesState["display"]> = {}): OpportunitiesState {
  return {
    filters: { squadIds: [SQUAD], ...over },
    display: { ...DEFAULT_OPPORTUNITIES_STATE.display, sort: "score", ...display },
  }
}

describe("resolveSurfaceState precedence", () => {
  it("falls back to defaults with no params and no view", () => {
    expect(resolve({})).toEqual(DEFAULT_OPPORTUNITIES_STATE)
  })

  it("layers the saved view under an un-edited URL", () => {
    const state = resolve({ saved: "v1" }, savedState())
    expect(state.filters.squadIds).toEqual([SQUAD])
    expect(state.display.sort).toBe("score")
  })

  it("lets explicit URL params win over the saved view", () => {
    const state = resolve({ saved: "v1", squad: SQUAD_2, sort: "manual" }, savedState())
    expect(state.filters.squadIds).toEqual([SQUAD_2])
    expect(state.display.sort).toBe("manual")
  })

  it("ignores the saved view entirely once edited=1, so a cleared filter stays cleared", () => {
    const state = resolve({ saved: "v1", edited: "1" }, savedState({}, { columns: { status: { order: ["EXPLORING"], hidden: [] } } }))
    expect(state).toEqual(DEFAULT_OPPORTUNITIES_STATE)
  })

  it("treats a stale or foreign saved id (no view passed) as the defaults", () => {
    expect(resolve({ saved: "deleted-or-foreign" }, null)).toEqual(DEFAULT_OPPORTUNITIES_STATE)
  })

  it("drops invalid tokens individually", () => {
    const state = resolve({ squad: "not-a-uuid", groupBy: "field:nope", view: "kanban", order: "BOGUS,EXPLORING,EXPLORING", hide: "NOPE" })
    expect(state.filters.squadIds).toEqual([])
    expect(state.display.groupBy).toBe("status")
    expect(state.display.view).toBe("board")
    expect(state.display.columns.status?.order[0]).toBe("EXPLORING")
    expect(state.display.columns.status?.hidden).toEqual([])
  })

  it("reads field grouping and custom-field filters", () => {
    const state = resolve({ groupBy: `field:${FIELD}`, field: FIELD, fieldValue: "must" })
    expect(state.display.groupBy).toBe(FIELD)
    expect(state.filters.customField).toEqual({ fieldId: FIELD, value: "must" })
  })

  it("lets order and hide override the saved layout independently", () => {
    const saved = savedState({}, { columns: { status: { order: ["EXPLORING", "ACTIVE"], hidden: ["VALIDATING"] } } })
    const onlyOrder = resolve({ saved: "v1", order: "PRIORITIZED" }, saved)
    expect(onlyOrder.display.columns.status?.order.slice(0, 1)).toEqual(["PRIORITIZED"])
    expect(onlyOrder.display.columns.status?.hidden).toEqual(["VALIDATING"])
    const onlyHide = resolve({ saved: "v1", hide: "EXPLORING" }, saved)
    expect(onlyHide.display.columns.status?.order.slice(0, 2)).toEqual(["EXPLORING", "ACTIVE"])
    expect(onlyHide.display.columns.status?.hidden).toEqual(["EXPLORING"])
  })
})

describe("column layout normalization", () => {
  it("omits a layout equal to the default", () => {
    expect(normalizeStatusLayout(undefined)).toBeUndefined()
    expect(normalizeStatusLayout({ order: ["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"], hidden: [] })).toBeUndefined()
  })

  it("appends statuses a saved order omits, so it is not 'modified' on load", () => {
    const saved = savedState({}, { columns: { status: { order: ["EXPLORING", "VALIDATING"], hidden: [] } } })
    expect(normalizeOpportunitiesState(saved).display.columns.status?.order).toEqual(["EXPLORING", "VALIDATING", "ACTIVE", "PRIORITIZED"])
    const live = resolve({ saved: "v1" }, saved)
    expect(isOpportunitiesStateModified(live, saved)).toBe(false)
  })

  it("is order-sensitive for the layout and drops unknown or duplicate keys", () => {
    const a = normalizeStatusLayout({ order: ["EXPLORING", "EXPLORING", "GONE"], hidden: ["GONE", "ACTIVE"] })
    expect(a).toEqual({ order: ["EXPLORING", "ACTIVE", "PRIORITIZED", "VALIDATING"], hidden: ["ACTIVE"] })
    const k = (order: string[]) => opportunitiesStateKey({ ...DEFAULT_OPPORTUNITIES_STATE, display: { ...DEFAULT_OPPORTUNITIES_STATE.display, columns: { status: { order, hidden: [] } } } })
    expect(k(["EXPLORING"])).not.toBe(k(["VALIDATING"]))
  })

  it("keeps other groupings' layouts untouched", () => {
    const state: OpportunitiesState = { ...DEFAULT_OPPORTUNITIES_STATE, display: { ...DEFAULT_OPPORTUNITIES_STATE.display, columns: { [FIELD]: { order: ["a"], hidden: [] } } } }
    expect(normalizeOpportunitiesState(state).display.columns[FIELD]).toEqual({ order: ["a"], hidden: [] })
  })
})

describe("URL round trip", () => {
  const rich: OpportunitiesState = {
    filters: { squadIds: [SQUAD], customField: { fieldId: FIELD, value: "must" } },
    display: { view: "table", groupBy: FIELD, sort: "score", columns: { status: { order: ["EXPLORING", "ACTIVE", "PRIORITIZED", "VALIDATING"], hidden: ["VALIDATING"] } } },
  }

  it("stateToParams then resolve is the identity", () => {
    const params = Object.fromEntries(opportunitiesStateToParams(rich).entries())
    expect(resolve(params)).toEqual(rich)
  })

  it("omits default values", () => {
    expect(opportunitiesStateToParams(DEFAULT_OPPORTUNITIES_STATE).toString()).toBe("")
  })

  it("writes order and hide only when they differ from the default", () => {
    const params = opportunitiesStateToParams(rich)
    expect(params.get("order")).toBe("EXPLORING,ACTIVE,PRIORITIZED,VALIDATING")
    expect(params.get("hide")).toBe("VALIDATING")
    const hideOnly = opportunitiesStateToParams(resolve({ hide: "EXPLORING" }))
    expect(hideOnly.has("order")).toBe(false)
    expect(hideOnly.get("hide")).toBe("EXPLORING")
  })

  it("builds the full edited=1 href only when a view is selected", () => {
    expect(opportunitiesHref("/a/b/discovery", DEFAULT_OPPORTUNITIES_STATE)).toBe("/a/b/discovery")
    const href = opportunitiesHref("/a/b/discovery", rich, "v1")
    const params = new URL(href, "http://x").searchParams
    expect(params.get("saved")).toBe("v1")
    expect(params.get("edited")).toBe("1")
    expect(resolve(Object.fromEntries(params.entries()), savedState())).toEqual(rich)
  })

  it("expands a bare saved link but not an edited one", () => {
    expect(needsSavedViewExpansion({ saved: "v1" })).toBe(true)
    expect(needsSavedViewExpansion({ saved: "v1", edited: "1" })).toBe(false)
    expect(needsSavedViewExpansion({})).toBe(false)
  })

  it("exposes the page's own vocabulary", () => {
    expect(opportunitiesPageParams(rich)).toEqual({ squad: SQUAD, field: FIELD, fieldValue: "must", view: "table", groupBy: `field:${FIELD}`, sort: "score" })
  })
})

describe("modified detection", () => {
  it("is false without a saved view and when state equals the view", () => {
    expect(isOpportunitiesStateModified(DEFAULT_OPPORTUNITIES_STATE, null)).toBe(false)
    expect(isOpportunitiesStateModified(resolve({ saved: "v" }, savedState()), savedState())).toBe(false)
  })

  it("is true after a column edit or filter change", () => {
    const saved = savedState()
    expect(isOpportunitiesStateModified(resolve({ saved: "v", hide: "EXPLORING" }, saved), saved)).toBe(true)
    expect(isOpportunitiesStateModified(resolve({ saved: "v", squad: SQUAD_2 }, saved), saved)).toBe(true)
  })
})

describe("stored document compatibility", () => {
  it("a normalized state validates as a saved view payload", () => {
    const state = resolve({ order: "EXPLORING", hide: "ACTIVE", squad: SQUAD })
    const input = savedViewInputSchemaFor("OPPORTUNITIES_BOARD").safeParse({ name: "Mine", visibility: "PERSONAL", ...state })
    expect(input.success).toBe(true)
  })

  it("rejects SHARED only in service; schema still parses visibility", () => {
    expect(savedViewInputSchemaFor("OPPORTUNITIES_BOARD").safeParse({ name: "x", visibility: "SHARED", filters: {}, display: {} }).success).toBe(true)
  })

  it("a stale stored status is dropped on read", () => {
    const display = parseStoredDisplayFor("OPPORTUNITIES_BOARD", { columns: { status: { order: ["GONE", "ACTIVE"], hidden: ["GONE"] } } }) as OpportunitiesState["display"]
    expect(display.columns.status).toEqual({ order: ["ACTIVE"], hidden: [] })
  })
})

describe("resolveOpportunityColumns", () => {
  it("defaults to Active first", () => {
    expect(resolveOpportunityColumns(undefined, {}).visible).toEqual(["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"])
  })

  it("applies a saved order and hides empty hidden columns", () => {
    const r = resolveOpportunityColumns({ order: ["EXPLORING"], hidden: ["VALIDATING"] }, {})
    expect(r.order).toEqual(["EXPLORING", "ACTIVE", "PRIORITIZED", "VALIDATING"])
    expect(r.visible).toEqual(["EXPLORING", "ACTIVE", "PRIORITIZED"])
  })

  it("forces a hidden column with cards visible", () => {
    const r = resolveOpportunityColumns({ order: [], hidden: ["EXPLORING"] }, { EXPLORING: 2 })
    expect(r.visible).toContain("EXPLORING")
    expect(r.forcedVisible).toEqual(["EXPLORING"])
  })
})
