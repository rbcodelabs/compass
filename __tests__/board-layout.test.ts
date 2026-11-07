import { describe, expect, it } from "vitest"
import {
  boardLayoutKey,
  boardLayoutSchema,
  canMoveColumn,
  collapseDock,
  expandDock,
  isDefaultBoardLayout,
  moveColumn,
  parseBoardLayout,
  pinColumn,
  pinnedTabOrder,
  reorderColumn,
  resolveBoardLayout,
  selectDockTab,
  serializeBoardLayout,
  setActiveColumn,
  togglePinColumn,
  unpinColumn,
  type BoardLayout,
} from "@/lib/board-layout"
import {
  ROADMAP_BOARD_COLUMN_IDS,
  ROADMAP_BOARD_LAYOUT_DEFAULTS,
  parseRoadmapBoardLayout,
  roadmapBoardLayoutKey,
  serializeRoadmapBoardLayout,
} from "@/lib/roadmap/board-layout"

const IDS = ["a", "b", "c", "d", "e"] as const
const DEFAULTS = { pinned: ["e"], active: "e", dockCollapsed: true }
const base = (): BoardLayout => resolveBoardLayout(undefined, IDS, DEFAULTS)
const L = (over: Partial<BoardLayout>): BoardLayout => ({ ...base(), ...over })

describe("resolveBoardLayout: defaults", () => {
  it("with no layout uses the known order, the default pin, the default active tab and a collapsed dock", () => {
    expect(base()).toEqual({ columnOrder: ["a", "b", "c", "d", "e"], pinnedColumnIds: ["e"], activePinnedId: "e", dockCollapsed: true })
  })

  it("without defaults nothing is pinned, there is no active tab and the dock is collapsed", () => {
    expect(resolveBoardLayout(undefined, IDS)).toEqual({ columnOrder: [...IDS], pinnedColumnIds: [], activePinnedId: null, dockCollapsed: true })
  })

  it("ignores defaults for columns that do not exist; a default active that is not pinned falls back to the first pinned", () => {
    expect(resolveBoardLayout(null, ["a", "b"], { pinned: ["zzz", "b"], active: "a" })).toEqual({
      columnOrder: ["a", "b"], pinnedColumnIds: ["b"], activePinnedId: "b", dockCollapsed: true,
    })
  })

  it("dockCollapsed defaults to true but a default can open the dock", () => {
    expect(resolveBoardLayout(undefined, IDS, { pinned: ["a"], dockCollapsed: false }).dockCollapsed).toBe(false)
  })
})

describe("resolveBoardLayout: stale, incomplete and older-shape layouts", () => {
  it("drops unknown ids everywhere and de-duplicates", () => {
    const layout = resolveBoardLayout(
      { columnOrder: ["c", "gone", "a", "c", "b", "d", "e"], pinnedColumnIds: ["gone", "b", "b"], activePinnedId: "gone", dockCollapsed: false },
      IDS, DEFAULTS,
    )
    expect(layout).toEqual({ columnOrder: ["c", "a", "b", "d", "e"], pinnedColumnIds: ["b"], activePinnedId: "b", dockCollapsed: false })
  })

  it("an active id that is not pinned becomes the first pinned tab (in column order)", () => {
    const layout = resolveBoardLayout({ columnOrder: ["c", "a", "b", "d", "e"], pinnedColumnIds: ["a", "c"], activePinnedId: "d", dockCollapsed: false }, IDS)
    expect(layout.activePinnedId).toBe("c")
  })

  it("an active id of null with pinned columns also becomes the first pinned tab", () => {
    expect(resolveBoardLayout({ columnOrder: [...IDS], pinnedColumnIds: ["b"], activePinnedId: null }, IDS).activePinnedId).toBe("b")
  })

  it("nothing pinned means no active tab and a collapsed dock, whatever was stored", () => {
    const layout = resolveBoardLayout({ columnOrder: [...IDS], pinnedColumnIds: [], activePinnedId: "a", dockCollapsed: false }, IDS)
    expect(layout).toMatchObject({ pinnedColumnIds: [], activePinnedId: null, dockCollapsed: true })
  })

  it("appends a column the layout has never heard of, at the end, with its default pin state", () => {
    const layout = resolveBoardLayout({ columnOrder: ["b", "a", "c", "d"], pinnedColumnIds: ["a"], activePinnedId: "a", dockCollapsed: false }, IDS, DEFAULTS)
    expect(layout.columnOrder).toEqual(["b", "a", "c", "d", "e"])
    expect(layout.pinnedColumnIds).toEqual(["a", "e"])
    expect(layout.activePinnedId).toBe("a") // the user's active tab is kept
    expect(layout.dockCollapsed).toBe(false)
  })

  it("a new column that does not default to pinned is appended unpinned", () => {
    const layout = resolveBoardLayout({ columnOrder: ["a", "b", "c", "e"], pinnedColumnIds: ["e"] }, IDS, DEFAULTS)
    expect(layout.columnOrder).toEqual(["a", "b", "c", "e", "d"])
    expect(layout.pinnedColumnIds).toEqual(["e"])
  })

  it("respects a user who deliberately unpinned a default-pinned column that the layout already lists", () => {
    expect(resolveBoardLayout({ columnOrder: [...IDS], pinnedColumnIds: [] }, IDS, DEFAULTS).pinnedColumnIds).toEqual([])
  })

  it("tolerates the OLD shape: collapsedColumnIds is ignored, the dock starts collapsed on the first pinned tab", () => {
    const old = { columnOrder: [...IDS], pinnedColumnIds: ["e", "b"], collapsedColumnIds: ["b"] }
    expect(parseBoardLayout(old, IDS, DEFAULTS)).toEqual({ columnOrder: [...IDS], pinnedColumnIds: ["e", "b"], activePinnedId: "b", dockCollapsed: true })
    // also through the resolver directly
    expect(resolveBoardLayout(old as never, IDS, DEFAULTS).dockCollapsed).toBe(true)
  })

  it("tolerates partial objects", () => {
    expect(resolveBoardLayout({}, IDS, DEFAULTS).columnOrder).toEqual([...IDS])
  })
})

describe("parseBoardLayout: untrusted input falls back to defaults", () => {
  const defaults = () => resolveBoardLayout(undefined, IDS, DEFAULTS)
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "pinned"],
    ["a number", 7],
    ["an array", []],
    ["an empty object", {}],
    ["wrong field types", { columnOrder: "a,b", pinnedColumnIds: [] }],
    ["non-string ids", { columnOrder: [1, 2], pinnedColumnIds: [] }],
    ["empty-string ids", { columnOrder: [""], pinnedColumnIds: [] }],
    ["a non-boolean dockCollapsed", { columnOrder: ["a"], pinnedColumnIds: [], dockCollapsed: "yes" }],
    ["a non-string active id", { columnOrder: ["a"], pinnedColumnIds: [], activePinnedId: 3 }],
    ["too many ids", { columnOrder: Array.from({ length: 51 }, (_, i) => `c${i}`), pinnedColumnIds: [] }],
  ])("%s", (_name, raw) => {
    expect(parseBoardLayout(raw, IDS, DEFAULTS)).toEqual(defaults())
  })

  it("accepts a valid layout (active and collapsed may be omitted)", () => {
    expect(parseBoardLayout({ columnOrder: ["b", "a"], pinnedColumnIds: ["a"] }, IDS, DEFAULTS)).toEqual({
      columnOrder: ["b", "a", "c", "d", "e"],
      pinnedColumnIds: ["a", "e"], // "e" is new to this layout: default pinned
      activePinnedId: "a",
      dockCollapsed: true,
    })
  })

  it("the schema itself requires order and pinned, and strips the old collapsedColumnIds", () => {
    expect(boardLayoutSchema.safeParse({}).success).toBe(false)
    const parsed = boardLayoutSchema.parse({ columnOrder: [], pinnedColumnIds: [], collapsedColumnIds: ["x"] })
    expect(parsed).not.toHaveProperty("collapsedColumnIds")
  })
})

describe("pin / unpin", () => {
  it("a newly pinned column becomes the active tab and opens the dock, without moving in the order", () => {
    const next = pinColumn(base(), "b")
    expect(next.pinnedColumnIds).toEqual(["e", "b"])
    expect(next.activePinnedId).toBe("b")
    expect(next.dockCollapsed).toBe(false)
    expect(next.columnOrder).toEqual(base().columnOrder)
  })

  it("more than one column can be pinned; they are tabs in column order", () => {
    const layout = pinColumn(pinColumn(base(), "c"), "a")
    expect(pinnedTabOrder(layout)).toEqual(["a", "c", "e"])
    expect(layout.activePinnedId).toBe("a")
  })

  it("unpinning the active tab activates its next neighbour, else the previous one", () => {
    const three = L({ pinnedColumnIds: ["a", "c", "e"], activePinnedId: "c", dockCollapsed: false })
    expect(unpinColumn(three, "c")).toMatchObject({ pinnedColumnIds: ["a", "e"], activePinnedId: "e", dockCollapsed: false })
    expect(unpinColumn(L({ ...three, activePinnedId: "e" }), "e")).toMatchObject({ pinnedColumnIds: ["a", "c"], activePinnedId: "c" })
  })

  it("unpinning a tab that is not active keeps the active one", () => {
    const three = L({ pinnedColumnIds: ["a", "c", "e"], activePinnedId: "c", dockCollapsed: false })
    expect(unpinColumn(three, "a").activePinnedId).toBe("c")
  })

  it("unpinning the last pinned column leaves no dock: no active tab, collapsed", () => {
    expect(unpinColumn(L({ dockCollapsed: false }), "e")).toMatchObject({ pinnedColumnIds: [], activePinnedId: null, dockCollapsed: true })
  })

  it("returns the same reference for no-ops (pin pinned, unpin unpinned, unknown id)", () => {
    const layout = base()
    expect(pinColumn(layout, "e")).toBe(layout)
    expect(pinColumn(layout, "nope")).toBe(layout)
    expect(unpinColumn(layout, "a")).toBe(layout)
  })

  it("togglePinColumn round-trips to a layout with the same pins", () => {
    const back = togglePinColumn(togglePinColumn(base(), "a"), "a")
    expect(back.pinnedColumnIds).toEqual(["e"])
    expect(back.activePinnedId).toBe("e")
  })

  it("does not mutate its input", () => {
    const layout = base()
    const snapshot = JSON.stringify(layout)
    pinColumn(layout, "a"); unpinColumn(layout, "e"); setActiveColumn(layout, "e"); expandDock(layout); moveColumn(layout, "b", "left")
    expect(JSON.stringify(layout)).toBe(snapshot)
  })
})

describe("dock: active tab, collapse, expand", () => {
  const two = () => L({ pinnedColumnIds: ["a", "e"], activePinnedId: "a", dockCollapsed: false })

  it("setActiveColumn switches the tab and opens the dock", () => {
    expect(setActiveColumn(L({ pinnedColumnIds: ["a", "e"], activePinnedId: "a", dockCollapsed: true }), "e")).toMatchObject({ activePinnedId: "e", dockCollapsed: false })
  })

  it("setActiveColumn on an unpinned column, or on the active tab of an open dock, is a no-op", () => {
    const layout = two()
    expect(setActiveColumn(layout, "b")).toBe(layout)
    expect(setActiveColumn(layout, "a")).toBe(layout)
  })

  it("collapseDock / expandDock", () => {
    expect(collapseDock(two()).dockCollapsed).toBe(true)
    expect(expandDock(collapseDock(two()))).toMatchObject({ dockCollapsed: false, activePinnedId: "a" })
    const open = two()
    expect(expandDock(open)).toBe(open)
    const collapsed = collapseDock(open)
    expect(collapseDock(collapsed)).toBe(collapsed)
  })

  it("expandDock with nothing pinned is a no-op", () => {
    const empty = resolveBoardLayout(undefined, IDS)
    expect(expandDock(empty)).toBe(empty)
  })

  it("selectDockTab: the active tab of an open dock closes it; any other tab (or a collapsed dock) opens that column", () => {
    expect(selectDockTab(two(), "a").dockCollapsed).toBe(true)
    expect(selectDockTab(two(), "e")).toMatchObject({ activePinnedId: "e", dockCollapsed: false })
    expect(selectDockTab(collapseDock(two()), "a")).toMatchObject({ activePinnedId: "a", dockCollapsed: false })
    const layout = two()
    expect(selectDockTab(layout, "b")).toBe(layout)
  })
})

describe("moveColumn (reorders dock tabs for pinned columns)", () => {
  it("swaps with the neighbour in the same region", () => {
    expect(moveColumn(base(), "c", "left").columnOrder).toEqual(["a", "c", "b", "d", "e"])
    expect(moveColumn(base(), "c", "right").columnOrder).toEqual(["a", "b", "d", "c", "e"])
  })

  it("is a no-op at the edges", () => {
    const layout = base()
    expect(moveColumn(layout, "a", "left")).toBe(layout)
    expect(moveColumn(layout, "d", "right")).toBe(layout) // "e" is pinned: a different region
    expect(canMoveColumn(layout, "a", "left")).toBe(false)
    expect(canMoveColumn(layout, "a", "right")).toBe(true)
  })

  it("pinned columns move among the pinned columns only, changing tab order and keeping the active tab", () => {
    const layout = L({ pinnedColumnIds: ["a", "c", "e"], activePinnedId: "c", dockCollapsed: false })
    const moved = moveColumn(layout, "c", "left")
    expect(moved.columnOrder).toEqual(["c", "b", "a", "d", "e"])
    expect(pinnedTabOrder(moved)).toEqual(["c", "a", "e"])
    expect(moved.activePinnedId).toBe("c")
    expect(moveColumn(layout, "a", "right").columnOrder).toEqual(["c", "b", "a", "d", "e"])
  })

  it("an `among` scope excludes columns that are not rendered", () => {
    const among = (id: string) => id !== "b"
    expect(moveColumn(base(), "c", "left", { among }).columnOrder).toEqual(["c", "b", "a", "d", "e"])
    expect(canMoveColumn(base(), "a", "right", { among: () => false })).toBe(false)
  })

  it("an `among` scope that spans pinned and unpinned moves across them (narrow screens)", () => {
    expect(moveColumn(base(), "d", "right", { among: () => true }).columnOrder).toEqual(["a", "b", "c", "e", "d"])
  })

  it("unknown ids can't move", () => {
    expect(canMoveColumn(base(), "nope", "left")).toBe(false)
  })
})

describe("reorderColumn (drag primitive)", () => {
  it("places the column at the target's position within its region", () => {
    expect(reorderColumn(base(), "a", "c").columnOrder).toEqual(["b", "c", "a", "d", "e"])
    expect(reorderColumn(base(), "d", "a").columnOrder).toEqual(["d", "a", "b", "c", "e"])
  })

  it("ignores targets in another region and self-drops", () => {
    const layout = base()
    expect(reorderColumn(layout, "a", "e")).toBe(layout)
    expect(reorderColumn(layout, "a", "a")).toBe(layout)
  })

  it("leaves other regions' slots alone", () => {
    const layout = pinColumn(base(), "b") // pinned: b, e; scroller: a, c, d
    expect(reorderColumn(layout, "a", "d").columnOrder).toEqual(["c", "b", "d", "a", "e"])
  })
})

describe("serialize / default detection", () => {
  it("the default layout serializes to undefined", () => {
    expect(isDefaultBoardLayout(base(), IDS, DEFAULTS)).toBe(true)
    expect(serializeBoardLayout(base(), IDS, DEFAULTS)).toBeUndefined()
  })

  it("expanding the dock, or switching the active tab, is a change", () => {
    expect(serializeBoardLayout(expandDock(base()), IDS, DEFAULTS)).toMatchObject({ dockCollapsed: false })
    const two = L({ pinnedColumnIds: ["a", "e"], activePinnedId: "e" })
    expect(isDefaultBoardLayout(two, IDS, DEFAULTS)).toBe(false)
  })

  it("a changed layout serializes to itself", () => {
    const changed = pinColumn(base(), "b")
    expect(serializeBoardLayout(changed, IDS, DEFAULTS)).toEqual(changed)
    expect(boardLayoutKey(changed)).not.toBe(boardLayoutKey(base()))
  })

  it("key ignores the order of the pinned set but not the column order, the active tab or the collapsed flag", () => {
    const x: BoardLayout = { columnOrder: ["a", "b"], pinnedColumnIds: ["a", "b"], activePinnedId: "a", dockCollapsed: false }
    expect(boardLayoutKey(x)).toBe(boardLayoutKey({ ...x, pinnedColumnIds: ["b", "a"] }))
    expect(boardLayoutKey(x)).not.toBe(boardLayoutKey({ ...x, columnOrder: ["b", "a"] }))
    expect(boardLayoutKey(x)).not.toBe(boardLayoutKey({ ...x, activePinnedId: "b" }))
    expect(boardLayoutKey(x)).not.toBe(boardLayoutKey({ ...x, dockCollapsed: true }))
  })
})

describe("roadmap binding", () => {
  it("defaults to Not scheduled pinned and active, the dock collapsed to a tab rail, after every horizon", () => {
    const layout = parseRoadmapBoardLayout(undefined)
    expect(layout.columnOrder).toEqual(["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED", "unscheduled"])
    expect(layout.pinnedColumnIds).toEqual(["unscheduled"])
    expect(layout.activePinnedId).toBe("unscheduled")
    expect(layout.dockCollapsed).toBe(true)
    expect(ROADMAP_BOARD_COLUMN_IDS).toContain("unscheduled")
    expect(ROADMAP_BOARD_LAYOUT_DEFAULTS.pinned).toEqual(["unscheduled"])
  })

  it("an absent stored layout and an explicit default have the same key; a stale one is reconciled", () => {
    expect(roadmapBoardLayoutKey(undefined)).toBe(roadmapBoardLayoutKey(parseRoadmapBoardLayout(undefined)))
    const stale = { columnOrder: ["SHIPPED", "OLD_HORIZON", "NOW"], pinnedColumnIds: ["OLD_HORIZON", "LATER"] }
    const resolved = parseRoadmapBoardLayout(stale)
    expect(resolved.columnOrder).toEqual(["SHIPPED", "NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "unscheduled"])
    expect(resolved.pinnedColumnIds).toEqual(["LATER", "unscheduled"])
    expect(resolved.activePinnedId).toBe("LATER")
  })

  it("an old-shape layout from the side-by-side build still loads", () => {
    const old = { columnOrder: [...ROADMAP_BOARD_COLUMN_IDS], pinnedColumnIds: ["unscheduled", "LATER"], collapsedColumnIds: ["LATER"] }
    expect(parseRoadmapBoardLayout(old)).toMatchObject({ pinnedColumnIds: ["unscheduled", "LATER"], activePinnedId: "LATER", dockCollapsed: true })
  })

  it("serializes only when something differs from the default", () => {
    expect(serializeRoadmapBoardLayout(parseRoadmapBoardLayout(undefined))).toBeUndefined()
    expect(serializeRoadmapBoardLayout(pinColumn(parseRoadmapBoardLayout(undefined), "LATER"))).toMatchObject({ pinnedColumnIds: ["unscheduled", "LATER"], activePinnedId: "LATER", dockCollapsed: false })
  })
})
