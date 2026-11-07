import { describe, expect, it } from "vitest"
import { pinColumn, moveColumn, resolveBoardLayout } from "@/lib/board-layout"
import {
  OPPORTUNITY_BOARD_COLUMN_IDS,
  OPPORTUNITY_BOARD_LAYOUT_DEFAULTS,
  effectiveStoredLayout,
  legacyOrderToLayout,
  opportunityBoardLayoutKey,
  parseOpportunityBoardLayout,
  resolveOpportunityBoardLayout,
  serializeOpportunityBoardLayout,
} from "@/lib/discovery/board-layout"

describe("Opportunities board layout binding", () => {
  it("knows every status column, Active first, and ARCHIVED is not a column", () => {
    expect([...OPPORTUNITY_BOARD_COLUMN_IDS]).toEqual(["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"])
    expect(OPPORTUNITY_BOARD_COLUMN_IDS).not.toContain("ARCHIVED")
  })

  it("starts with nothing pinned, no active tab and the dock collapsed", () => {
    expect(resolveOpportunityBoardLayout(undefined)).toEqual({
      columnOrder: ["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"],
      pinnedColumnIds: [],
      activePinnedId: null,
      dockCollapsed: true,
    })
    expect(OPPORTUNITY_BOARD_LAYOUT_DEFAULTS.pinned).toEqual([])
  })

  it("serializes the default layout as undefined so untouched views stay byte-identical", () => {
    expect(serializeOpportunityBoardLayout(resolveOpportunityBoardLayout(undefined))).toBeUndefined()
  })

  it("serializes a pinned layout in full and round-trips it", () => {
    const pinned = pinColumn(resolveOpportunityBoardLayout(undefined), "EXPLORING")
    const stored = serializeOpportunityBoardLayout(pinned)
    expect(stored).toEqual({
      columnOrder: ["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"],
      pinnedColumnIds: ["EXPLORING"],
      activePinnedId: "EXPLORING",
      dockCollapsed: false,
    })
    expect(parseOpportunityBoardLayout(stored)).toEqual(pinned)
  })

  it("degrades corrupt input to the defaults", () => {
    for (const bad of [null, "nope", 7, {}, { columnOrder: "x", pinnedColumnIds: [] }, { columnOrder: [], pinnedColumnIds: [3] }]) {
      expect(parseOpportunityBoardLayout(bad)).toEqual(resolveOpportunityBoardLayout(undefined))
    }
  })

  it("drops stale ids (including ARCHIVED) and appends statuses a stored layout never mentioned", () => {
    const layout = parseOpportunityBoardLayout({ columnOrder: ["EXPLORING", "ARCHIVED", "ACTIVE"], pinnedColumnIds: ["ARCHIVED", "EXPLORING"], activePinnedId: "ARCHIVED" })
    expect(layout.columnOrder).toEqual(["EXPLORING", "ACTIVE", "PRIORITIZED", "VALIDATING"])
    expect(layout.pinnedColumnIds).toEqual(["EXPLORING"])
    expect(layout.activePinnedId).toBe("EXPLORING")
  })

  it("compares an absent layout and an explicit default layout as equal", () => {
    expect(opportunityBoardLayoutKey(undefined)).toBe(opportunityBoardLayoutKey(resolveOpportunityBoardLayout(undefined)))
    expect(opportunityBoardLayoutKey(pinColumn(resolveOpportunityBoardLayout(undefined), "ACTIVE"))).not.toBe(opportunityBoardLayoutKey(undefined))
  })

  it("keeps the pinned tab order equal to the column order when a column moves", () => {
    const two = pinColumn(pinColumn(resolveOpportunityBoardLayout(undefined), "EXPLORING"), "VALIDATING")
    expect(two.columnOrder.filter((id) => two.pinnedColumnIds.includes(id))).toEqual(["VALIDATING", "EXPLORING"])
    const swapped = moveColumn(two, "EXPLORING", "left")
    expect(swapped.columnOrder.slice(-2)).toEqual(["EXPLORING", "VALIDATING"])
  })
})

describe("legacy columns.status.order compatibility (read time, no migration)", () => {
  it("has no opinion when there is no legacy order", () => {
    expect(legacyOrderToLayout(undefined)).toBeUndefined()
    expect(legacyOrderToLayout([])).toBeUndefined()
  })

  it("turns a legacy order into that column order with nothing pinned; omitted statuses follow in default order", () => {
    const layout = legacyOrderToLayout(["EXPLORING", "VALIDATING"])!
    expect(layout.columnOrder).toEqual(["EXPLORING", "VALIDATING", "ACTIVE", "PRIORITIZED"])
    expect(layout.pinnedColumnIds).toEqual([])
    expect(layout.dockCollapsed).toBe(true)
  })

  it("drops unknown statuses", () => {
    expect(legacyOrderToLayout(["GONE", "ARCHIVED", "EXPLORING"])!.columnOrder[0]).toBe("EXPLORING")
  })

  it("a legacy order equal to the default is the default layout", () => {
    expect(serializeOpportunityBoardLayout(legacyOrderToLayout([...OPPORTUNITY_BOARD_COLUMN_IDS])!)).toBeUndefined()
  })

  it("prefers the stored columnLayout over the legacy order, and falls back to the legacy order without one", () => {
    const layout = resolveBoardLayout({ columnOrder: ["VALIDATING"], pinnedColumnIds: [] }, OPPORTUNITY_BOARD_COLUMN_IDS, OPPORTUNITY_BOARD_LAYOUT_DEFAULTS)
    const both = { columnLayout: layout, columns: { status: { order: ["EXPLORING"] } } }
    expect(resolveOpportunityBoardLayout(effectiveStoredLayout(both)).columnOrder[0]).toBe("VALIDATING")
    expect(resolveOpportunityBoardLayout(effectiveStoredLayout({ columns: both.columns })).columnOrder[0]).toBe("EXPLORING")
    expect(effectiveStoredLayout({ columns: {} })).toBeUndefined()
  })
})
