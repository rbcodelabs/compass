import { describe, expect, it } from "vitest"
import { DEFAULT_SOLUTION_COLUMN_ORDER } from "@/lib/saved-views/columns"
import { parseStoredDisplayFor, savedViewInputSchemaFor } from "@/lib/saved-views/schema"
import { resolveSolutionColumns, solutionColumnLabel } from "@/lib/saved-views/solution-columns"
import {
  DEFAULT_SOLUTIONS_STATE, isSolutionsStateModified, needsSolutionsViewExpansion, normalizeSolutionStatusLayout,
  resolveSolutionsState, solutionsHref, solutionsPageParams, solutionsStateToParams, type SolutionsState,
} from "@/lib/saved-views/solutions-state"

const SQUAD = "11111111-1111-4111-8111-111111111111"
const SQUAD_2 = "22222222-2222-4222-8222-222222222222"
const FIELD = "33333333-3333-4333-8333-333333333333"

function savedState(display: Partial<SolutionsState["display"]> = {}): SolutionsState {
  return {
    filters: { squadIds: [SQUAD] },
    display: { ...DEFAULT_SOLUTIONS_STATE.display, sort: "score", ...display },
  }
}

describe("default Solutions column order", () => {
  it("puts work in flight first and finished or abandoned work last", () => {
    expect([...DEFAULT_SOLUTION_COLUMN_ORDER]).toEqual(["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"])
    expect(resolveSolutionColumns(undefined, {}).visible).toEqual(["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"])
  })

  it("labels columns from the shared status presentation", () => {
    expect(solutionColumnLabel("IN_DELIVERY")).toBe("In delivery")
    expect(solutionColumnLabel("IDEA")).toBe("Idea")
  })
})

describe("resolveSolutionColumns", () => {
  it("appends statuses a saved order omits, in default order", () => {
    const columns = resolveSolutionColumns({ order: ["KILLED", "IDEA"], hidden: [] }, {})
    expect(columns.order).toEqual(["KILLED", "IDEA", "IN_DELIVERY", "VALIDATED", "SHIPPED"])
  })

  it("hides a column that is empty", () => {
    const columns = resolveSolutionColumns({ order: [], hidden: ["KILLED"] }, { KILLED: 0 })
    expect(columns.visible).not.toContain("KILLED")
    expect(columns.forcedVisible).toEqual([])
  })

  it("shows a hidden column anyway when it holds cards", () => {
    const columns = resolveSolutionColumns({ order: [], hidden: ["KILLED"] }, { KILLED: 2 })
    expect(columns.visible).toContain("KILLED")
    expect(columns.forcedVisible).toEqual(["KILLED"])
  })

  it("drops stale statuses from a stored layout", () => {
    const columns = resolveSolutionColumns({ order: ["GONE", "IDEA"], hidden: ["ALSO_GONE"] }, {})
    expect(columns.order[0]).toBe("IDEA")
    expect(columns.order).not.toContain("GONE")
  })
})

describe("resolveSolutionsState precedence", () => {
  it("falls back to defaults with no params and no view", () => {
    expect(resolveSolutionsState({}, null)).toEqual(DEFAULT_SOLUTIONS_STATE)
  })

  it("layers the saved view under an un-edited URL", () => {
    const state = resolveSolutionsState({ saved: "v1" }, savedState())
    expect(state.filters.squadIds).toEqual([SQUAD])
    expect(state.display.sort).toBe("score")
  })

  it("lets explicit URL params win over the saved view", () => {
    const state = resolveSolutionsState({ saved: "v1", squad: SQUAD_2, sort: "manual" }, savedState())
    expect(state.filters.squadIds).toEqual([SQUAD_2])
    expect(state.display.sort).toBe("manual")
  })

  it("ignores the saved view once edited=1", () => {
    const state = resolveSolutionsState({ saved: "v1", edited: "1" }, savedState())
    expect(state).toEqual(DEFAULT_SOLUTIONS_STATE)
  })

  it("drops invalid tokens individually", () => {
    const state = resolveSolutionsState(
      { squad: "not-a-uuid", groupBy: "field:nope", view: "kanban", order: "BOGUS,IDEA,IDEA", hide: "NOPE" },
      null,
    )
    expect(state.filters.squadIds).toEqual([])
    expect(state.display.groupBy).toBe("status")
    expect(state.display.view).toBe("board")
    expect(state.display.columns.status?.order[0]).toBe("IDEA")
    expect(state.display.columns.status?.hidden).toEqual([])
  })

  it("reads squad, opportunity and field groupings", () => {
    expect(resolveSolutionsState({ groupBy: "squad" }, null).display.groupBy).toBe("squad")
    expect(resolveSolutionsState({ groupBy: "opportunity" }, null).display.groupBy).toBe("opportunity")
    expect(resolveSolutionsState({ groupBy: "field:" + FIELD }, null).display.groupBy).toBe(FIELD)
  })

  it("lets order and hide override the saved layout independently", () => {
    const saved = savedState({ columns: { status: { order: ["IDEA", "SHIPPED"], hidden: ["KILLED"] } } })
    const onlyOrder = resolveSolutionsState({ saved: "v1", order: "VALIDATED" }, saved)
    expect(onlyOrder.display.columns.status?.order[0]).toBe("VALIDATED")
    expect(onlyOrder.display.columns.status?.hidden).toEqual(["KILLED"])
    const onlyHide = resolveSolutionsState({ saved: "v1", hide: "IDEA" }, saved)
    expect(onlyHide.display.columns.status?.order.slice(0, 2)).toEqual(["IDEA", "SHIPPED"])
    expect(onlyHide.display.columns.status?.hidden).toEqual(["IDEA"])
  })
})

describe("layout normalization", () => {
  it("stores nothing for the default layout", () => {
    expect(normalizeSolutionStatusLayout({ order: [...DEFAULT_SOLUTION_COLUMN_ORDER], hidden: [] })).toBeUndefined()
    expect(normalizeSolutionStatusLayout(undefined)).toBeUndefined()
  })

  it("stores the full resolved order and the known hidden statuses", () => {
    expect(normalizeSolutionStatusLayout({ order: ["KILLED"], hidden: ["KILLED", "NOPE"] })).toEqual({
      order: ["KILLED", "IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED"],
      hidden: ["KILLED"],
    })
  })
})

describe("URL round trip", () => {
  it("omits default values", () => {
    expect(solutionsStateToParams(DEFAULT_SOLUTIONS_STATE).toString()).toBe("")
  })

  it("round-trips a full state through params", () => {
    const state: SolutionsState = {
      filters: { squadIds: [SQUAD], customField: { fieldId: FIELD, value: "must" } },
      display: {
        view: "table", groupBy: "squad", sort: "score",
        columns: { status: { order: ["IDEA", "IN_DELIVERY", "VALIDATED", "SHIPPED", "KILLED"], hidden: ["KILLED"] } },
      },
    }
    const params = Object.fromEntries(solutionsStateToParams(state).entries())
    expect(resolveSolutionsState(params, null)).toEqual(state)
  })

  it("builds the full edited=1 href for a selected saved view", () => {
    const href = solutionsHref("/org/ws/solutions", DEFAULT_SOLUTIONS_STATE, "view-1")
    expect(href).toBe("/org/ws/solutions?saved=view-1&edited=1")
    expect(solutionsHref("/org/ws/solutions", DEFAULT_SOLUTIONS_STATE)).toBe("/org/ws/solutions")
  })

  it("expands only a bare saved id", () => {
    expect(needsSolutionsViewExpansion({ saved: "v1" })).toBe(true)
    expect(needsSolutionsViewExpansion({ saved: "v1", edited: "1" })).toBe(false)
    expect(needsSolutionsViewExpansion({})).toBe(false)
  })

  it("reads page params back in the URL vocabulary", () => {
    const page = solutionsPageParams(resolveSolutionsState({ groupBy: "opportunity", sort: "score" }, null))
    expect(page.groupBy).toBe("opportunity")
    expect(page.sort).toBe("score")
    expect(page.view).toBe("board")
  })
})

describe("modified detection", () => {
  it("is not modified when only an omitted status differs", () => {
    const saved = savedState({ columns: { status: { order: ["IDEA"], hidden: [] } } })
    expect(isSolutionsStateModified(resolveSolutionsState({ saved: "v1", order: "IDEA" }, saved), saved)).toBe(false)
  })

  it("is modified once the layout changes, and never without a saved view", () => {
    const saved = savedState()
    const changed = resolveSolutionsState({ saved: "v1", order: "KILLED" }, saved)
    expect(isSolutionsStateModified(changed, saved)).toBe(true)
    expect(isSolutionsStateModified(changed, null)).toBe(false)
  })
})

describe("saved-view schema for Solutions", () => {
  it("accepts squad and opportunity groupings, and rejects them for Opportunities", () => {
    const body = { name: "Mine", filters: { squadIds: [] }, display: { groupBy: "squad" } }
    expect(savedViewInputSchemaFor("SOLUTIONS_BOARD").safeParse(body).success).toBe(true)
    expect(savedViewInputSchemaFor("SOLUTIONS_BOARD").safeParse({ ...body, display: { groupBy: "opportunity" } }).success).toBe(true)
    expect(savedViewInputSchemaFor("OPPORTUNITIES_BOARD").safeParse(body).success).toBe(false)
  })

  it("keeps only real Solution statuses in a stored layout", () => {
    const display = parseStoredDisplayFor("SOLUTIONS_BOARD", { columns: { status: { order: ["IDEA", "EXPLORING"], hidden: ["KILLED", "ARCHIVED"] } } }) as SolutionsState["display"]
    expect(display.columns.status).toEqual({ order: ["IDEA"], hidden: ["KILLED"] })
  })
})
