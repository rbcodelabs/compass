import { describe, expect, it } from "vitest"
import {
  boardLayoutKey,
  boardLayoutSchema,
  canMoveColumn,
  isDefaultBoardLayout,
  moveColumn,
  parseBoardLayout,
  pinColumn,
  reorderColumn,
  resolveBoardLayout,
  serializeBoardLayout,
  setColumnCollapsed,
  togglePinColumn,
  toggleColumnCollapsed,
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
const DEFAULTS = { pinned: ["e"], collapsed: ["e"] }
const base = (): BoardLayout => resolveBoardLayout(undefined, IDS, DEFAULTS)

describe("resolveBoardLayout: defaults", () => {
  it("with no layout uses the known order and the default pin/collapse", () => {
    expect(base()).toEqual({ columnOrder: ["a", "b", "c", "d", "e"], pinnedColumnIds: ["e"], collapsedColumnIds: ["e"] })
  })

  it("without defaults nothing is pinned", () => {
    expect(resolveBoardLayout(undefined, IDS)).toEqual({ columnOrder: [...IDS], pinnedColumnIds: [], collapsedColumnIds: [] })
  })

  it("ignores defaults for columns that do not exist", () => {
    expect(resolveBoardLayout(null, ["a"], { pinned: ["zzz", "a"], collapsed: ["zzz"] })).toEqual({
      columnOrder: ["a"], pinnedColumnIds: ["a"], collapsedColumnIds: [],
    })
  })

  it("a default-collapsed column that is not default-pinned is not collapsed (collapsed is a subset of pinned)", () => {
    expect(resolveBoardLayout(undefined, IDS, { pinned: [], collapsed: ["a"] }).collapsedColumnIds).toEqual([])
  })
})

describe("resolveBoardLayout: stale and incomplete layouts", () => {
  it("drops unknown ids everywhere and de-duplicates", () => {
    const layout = resolveBoardLayout(
      { columnOrder: ["c", "gone", "a", "c", "b", "d", "e"], pinnedColumnIds: ["gone", "b", "b"], collapsedColumnIds: ["gone", "b", "b"] },
      IDS, DEFAULTS,
    )
    expect(layout).toEqual({ columnOrder: ["c", "a", "b", "d", "e"], pinnedColumnIds: ["b"], collapsedColumnIds: ["b"] })
  })

  it("appends a column the layout has never heard of, at the end, with its default placement", () => {
    const layout = resolveBoardLayout({ columnOrder: ["b", "a", "c", "d"], pinnedColumnIds: ["a"], collapsedColumnIds: [] }, IDS, DEFAULTS)
    expect(layout.columnOrder).toEqual(["b", "a", "c", "d", "e"])
    // "e" is new to this layout and defaults to pinned + collapsed
    expect(layout.pinnedColumnIds).toEqual(["a", "e"])
    expect(layout.collapsedColumnIds).toEqual(["e"])
  })

  it("a new column that does not default to pinned is appended unpinned", () => {
    const layout = resolveBoardLayout({ columnOrder: ["a", "b", "c", "e"], pinnedColumnIds: ["e"], collapsedColumnIds: [] }, IDS, DEFAULTS)
    expect(layout.columnOrder).toEqual(["a", "b", "c", "e", "d"])
    expect(layout.pinnedColumnIds).toEqual(["e"])
  })

  it("respects a user who deliberately unpinned a default-pinned column that the layout already lists", () => {
    const layout = resolveBoardLayout({ columnOrder: [...IDS], pinnedColumnIds: [], collapsedColumnIds: [] }, IDS, DEFAULTS)
    expect(layout.pinnedColumnIds).toEqual([])
  })

  it("clamps collapsed to pinned", () => {
    const layout = resolveBoardLayout({ columnOrder: [...IDS], pinnedColumnIds: ["a"], collapsedColumnIds: ["a", "b"] }, IDS)
    expect(layout.collapsedColumnIds).toEqual(["a"])
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
    ["wrong field types", { columnOrder: "a,b", pinnedColumnIds: [], collapsedColumnIds: [] }],
    ["non-string ids", { columnOrder: [1, 2], pinnedColumnIds: [], collapsedColumnIds: [] }],
    ["empty-string ids", { columnOrder: [""], pinnedColumnIds: [], collapsedColumnIds: [] }],
    ["too many ids", { columnOrder: Array.from({ length: 51 }, (_, i) => `c${i}`), pinnedColumnIds: [], collapsedColumnIds: [] }],
  ])("%s", (_name, raw) => {
    expect(parseBoardLayout(raw, IDS, DEFAULTS)).toEqual(defaults())
  })

  it("accepts a valid layout (collapsedColumnIds may be omitted)", () => {
    expect(parseBoardLayout({ columnOrder: ["b", "a"], pinnedColumnIds: ["a"] }, IDS, DEFAULTS)).toEqual({
      columnOrder: ["b", "a", "c", "d", "e"],
      pinnedColumnIds: ["a", "e"], // "e" is new to this layout: default pinned + collapsed
      collapsedColumnIds: ["e"],
    })
  })

  it("the schema itself requires order and pinned", () => {
    expect(boardLayoutSchema.safeParse({}).success).toBe(false)
    expect(boardLayoutSchema.safeParse({ columnOrder: [], pinnedColumnIds: [] }).success).toBe(true)
  })
})

describe("pin / unpin / collapse", () => {
  it("pins a column without moving it in the order", () => {
    const next = pinColumn(base(), "b")
    expect(next.pinnedColumnIds).toEqual(["e", "b"])
    expect(next.columnOrder).toEqual(base().columnOrder)
  })

  it("more than one column can be pinned", () => {
    expect(pinColumn(pinColumn(base(), "a"), "c").pinnedColumnIds).toEqual(["e", "a", "c"])
  })

  it("unpinning clears the collapsed flag", () => {
    const next = unpinColumn(base(), "e")
    expect(next.pinnedColumnIds).toEqual([])
    expect(next.collapsedColumnIds).toEqual([])
  })

  it("returns the same reference for no-ops (pin pinned, unpin unpinned, unknown id)", () => {
    const layout = base()
    expect(pinColumn(layout, "e")).toBe(layout)
    expect(pinColumn(layout, "nope")).toBe(layout)
    expect(unpinColumn(layout, "a")).toBe(layout)
    expect(setColumnCollapsed(layout, "e", true)).toBe(layout)
  })

  it("togglePinColumn round-trips", () => {
    expect(togglePinColumn(togglePinColumn(base(), "a"), "a")).toEqual(base())
  })

  it("only a pinned column can collapse; expand/collapse toggles", () => {
    const layout = base()
    expect(setColumnCollapsed(layout, "a", true)).toBe(layout)
    const expanded = setColumnCollapsed(layout, "e", false)
    expect(expanded.collapsedColumnIds).toEqual([])
    expect(toggleColumnCollapsed(expanded, "e").collapsedColumnIds).toEqual(["e"])
  })

  it("does not mutate its input", () => {
    const layout = base()
    const snapshot = JSON.stringify(layout)
    pinColumn(layout, "a"); unpinColumn(layout, "e"); setColumnCollapsed(layout, "e", false); moveColumn(layout, "b", "left")
    expect(JSON.stringify(layout)).toBe(snapshot)
  })
})

describe("moveColumn", () => {
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

  it("pinned columns move among the pinned columns only", () => {
    const layout = pinColumn(pinColumn(base(), "a"), "c") // pinned: a, c, e (in column order)
    expect(moveColumn(layout, "c", "left").columnOrder).toEqual(["c", "b", "a", "d", "e"])
    // a (pinned) can't move left past nothing, and moving right swaps with c, skipping the unpinned b
    expect(moveColumn(layout, "a", "right").columnOrder).toEqual(["c", "b", "a", "d", "e"])
  })

  it("an `among` scope excludes columns that are not rendered", () => {
    const among = (id: string) => id !== "b" // b is hidden
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

  it("a changed layout serializes to itself", () => {
    const changed = pinColumn(base(), "b")
    expect(serializeBoardLayout(changed, IDS, DEFAULTS)).toEqual(changed)
    expect(boardLayoutKey(changed)).not.toBe(boardLayoutKey(base()))
  })

  it("key ignores the order of the pin/collapse sets but not the column order", () => {
    const x: BoardLayout = { columnOrder: ["a", "b"], pinnedColumnIds: ["a", "b"], collapsedColumnIds: ["a", "b"] }
    const y: BoardLayout = { columnOrder: ["a", "b"], pinnedColumnIds: ["b", "a"], collapsedColumnIds: ["b", "a"] }
    const z: BoardLayout = { ...x, columnOrder: ["b", "a"] }
    expect(boardLayoutKey(x)).toBe(boardLayoutKey(y))
    expect(boardLayoutKey(x)).not.toBe(boardLayoutKey(z))
  })
})

describe("roadmap binding", () => {
  it("defaults to Not scheduled pinned right and collapsed, after every horizon", () => {
    const layout = parseRoadmapBoardLayout(undefined)
    expect(layout.columnOrder).toEqual(["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED", "unscheduled"])
    expect(layout.pinnedColumnIds).toEqual(["unscheduled"])
    expect(layout.collapsedColumnIds).toEqual(["unscheduled"])
    expect(ROADMAP_BOARD_COLUMN_IDS).toContain("unscheduled")
    expect(ROADMAP_BOARD_LAYOUT_DEFAULTS.pinned).toEqual(["unscheduled"])
  })

  it("an absent stored layout and an explicit default have the same key; a stale one is reconciled", () => {
    expect(roadmapBoardLayoutKey(undefined)).toBe(roadmapBoardLayoutKey(parseRoadmapBoardLayout(undefined)))
    const stale = { columnOrder: ["SHIPPED", "OLD_HORIZON", "NOW"], pinnedColumnIds: ["OLD_HORIZON", "LATER"], collapsedColumnIds: [] }
    const resolved = parseRoadmapBoardLayout(stale)
    expect(resolved.columnOrder).toEqual(["SHIPPED", "NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "unscheduled"])
    expect(resolved.pinnedColumnIds).toEqual(["LATER", "unscheduled"])
  })

  it("serializes only when something differs from the default", () => {
    expect(serializeRoadmapBoardLayout(parseRoadmapBoardLayout(undefined))).toBeUndefined()
    expect(serializeRoadmapBoardLayout(pinColumn(parseRoadmapBoardLayout(undefined), "LATER"))?.pinnedColumnIds).toEqual(["unscheduled", "LATER"])
  })
})
