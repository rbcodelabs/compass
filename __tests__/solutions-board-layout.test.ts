import { describe, expect, it } from "vitest"
import { pinColumn, moveColumn, resolveBoardLayout } from "@/lib/board-layout"
import {
  SOLUTION_BOARD_COLUMN_IDS,
  SOLUTION_BOARD_LAYOUT_DEFAULTS,
  effectiveStoredLayout,
  legacyOrderToLayout,
  parseSolutionBoardLayout,
  resolveSolutionBoardLayout,
  serializeSolutionBoardLayout,
  solutionBoardLayoutKey,
} from "@/lib/solutions/board-layout"

describe("Solutions board layout binding", () => {
  it("knows every status column, active work first", () => {
    expect([...SOLUTION_BOARD_COLUMN_IDS]).toEqual(["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"])
  })

  it("starts with nothing pinned, no active tab and the dock collapsed", () => {
    expect(resolveSolutionBoardLayout(undefined)).toEqual({
      columnOrder: ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"],
      pinnedColumnIds: [],
      activePinnedId: null,
      dockCollapsed: true,
    })
    expect(SOLUTION_BOARD_LAYOUT_DEFAULTS.pinned).toEqual([])
  })

  it("serializes the default layout as undefined so untouched views stay byte-identical", () => {
    expect(serializeSolutionBoardLayout(resolveSolutionBoardLayout(undefined))).toBeUndefined()
  })

  it("serializes a pinned layout in full and round-trips it", () => {
    const pinned = pinColumn(resolveSolutionBoardLayout(undefined), "SHIPPED")
    const stored = serializeSolutionBoardLayout(pinned)
    expect(stored).toEqual({
      columnOrder: ["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"],
      pinnedColumnIds: ["SHIPPED"],
      activePinnedId: "SHIPPED",
      dockCollapsed: false,
    })
    expect(parseSolutionBoardLayout(stored)).toEqual(pinned)
  })

  it("degrades corrupt input to the defaults", () => {
    for (const bad of [null, "nope", 7, {}, { columnOrder: "x", pinnedColumnIds: [] }, { columnOrder: [], pinnedColumnIds: [3] }]) {
      expect(parseSolutionBoardLayout(bad)).toEqual(resolveSolutionBoardLayout(undefined))
    }
  })

  it("drops stale ids and appends statuses a stored layout never mentioned", () => {
    const layout = parseSolutionBoardLayout({ columnOrder: ["KILLED", "GONE", "IDEA"], pinnedColumnIds: ["GONE", "KILLED"], activePinnedId: "GONE" })
    expect(layout.columnOrder).toEqual(["KILLED", "IDEA", "IN_DELIVERY", "VALIDATED", "SHIPPED"])
    expect(layout.pinnedColumnIds).toEqual(["KILLED"])
    expect(layout.activePinnedId).toBe("KILLED")
  })

  it("compares an absent layout and an explicit default layout as equal", () => {
    expect(solutionBoardLayoutKey(undefined)).toBe(solutionBoardLayoutKey(resolveSolutionBoardLayout(undefined)))
    expect(solutionBoardLayoutKey(pinColumn(resolveSolutionBoardLayout(undefined), "KILLED"))).not.toBe(solutionBoardLayoutKey(undefined))
  })

  it("keeps the pinned tab order equal to the column order when a column moves", () => {
    const two = pinColumn(pinColumn(resolveSolutionBoardLayout(undefined), "KILLED"), "SHIPPED")
    expect(two.columnOrder.filter((id) => two.pinnedColumnIds.includes(id))).toEqual(["SHIPPED", "KILLED"])
    const swapped = moveColumn(two, "KILLED", "left")
    expect(swapped.columnOrder.slice(-2)).toEqual(["KILLED", "SHIPPED"])
  })
})

describe("legacy columns.status.order compatibility (read time, no migration)", () => {
  it("has no opinion when there is no legacy order", () => {
    expect(legacyOrderToLayout(undefined)).toBeUndefined()
    expect(legacyOrderToLayout([])).toBeUndefined()
  })

  it("turns a legacy order into that column order with nothing pinned; omitted statuses follow in default order", () => {
    const layout = legacyOrderToLayout(["IDEA", "SHIPPED"])!
    expect(layout.columnOrder).toEqual(["IDEA", "SHIPPED", "IN_DELIVERY", "VALIDATED", "KILLED"])
    expect(layout.pinnedColumnIds).toEqual([])
    expect(layout.dockCollapsed).toBe(true)
  })

  it("drops unknown statuses", () => {
    expect(legacyOrderToLayout(["GONE", "IDEA"])!.columnOrder[0]).toBe("IDEA")
  })

  it("a legacy order equal to the default is the default layout", () => {
    expect(serializeSolutionBoardLayout(legacyOrderToLayout([...SOLUTION_BOARD_COLUMN_IDS])!)).toBeUndefined()
  })

  it("prefers the stored columnLayout over the legacy order, and falls back to the legacy order without one", () => {
    const layout = resolveBoardLayout({ columnOrder: ["KILLED"], pinnedColumnIds: [] }, SOLUTION_BOARD_COLUMN_IDS, SOLUTION_BOARD_LAYOUT_DEFAULTS)
    const both = { columnLayout: layout, columns: { status: { order: ["IDEA"] } } }
    expect(resolveSolutionBoardLayout(effectiveStoredLayout(both)).columnOrder[0]).toBe("KILLED")
    expect(resolveSolutionBoardLayout(effectiveStoredLayout({ columns: both.columns })).columnOrder[0]).toBe("IDEA")
    expect(effectiveStoredLayout({ columns: {} })).toBeUndefined()
  })
})
