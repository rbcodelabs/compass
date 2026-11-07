import { describe, expect, it } from "vitest"
import { moveColumn, pinColumn } from "@/lib/board-layout"
import {
  TASK_BOARD_COLUMN_IDS,
  TASK_BOARD_LAYOUT_DEFAULTS,
  TASK_BOARD_STATUSES,
  parseTaskBoardLayout,
  resolveTaskBoardLayout,
  serializeTaskBoardLayout,
  taskBoardLayoutKey,
} from "@/lib/tasks/board-layout"

describe("Tasks board layout binding", () => {
  it("knows every status column in workflow order, with CANCELLED last and outside the always-on statuses", () => {
    expect([...TASK_BOARD_COLUMN_IDS]).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"])
    expect([...TASK_BOARD_STATUSES]).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"])
  })

  it("starts with nothing pinned, no active tab and the dock collapsed", () => {
    expect(resolveTaskBoardLayout(undefined)).toEqual({
      columnOrder: [...TASK_BOARD_COLUMN_IDS],
      pinnedColumnIds: [],
      activePinnedId: null,
      dockCollapsed: true,
    })
    expect(TASK_BOARD_LAYOUT_DEFAULTS.pinned).toEqual([])
  })

  it("serializes the default layout as undefined so untouched views stay byte-identical", () => {
    expect(serializeTaskBoardLayout(resolveTaskBoardLayout(undefined))).toBeUndefined()
  })

  it("serializes a pinned layout in full and round-trips it", () => {
    const pinned = pinColumn(resolveTaskBoardLayout(undefined), "DONE")
    const stored = serializeTaskBoardLayout(pinned)
    expect(stored).toEqual({
      columnOrder: [...TASK_BOARD_COLUMN_IDS],
      pinnedColumnIds: ["DONE"],
      activePinnedId: "DONE",
      dockCollapsed: false,
    })
    expect(parseTaskBoardLayout(stored)).toEqual(pinned)
  })

  it("degrades corrupt input to the defaults", () => {
    for (const bad of [null, "nope", 7, {}, { columnOrder: "x", pinnedColumnIds: [] }, { columnOrder: [], pinnedColumnIds: [3] }]) {
      expect(parseTaskBoardLayout(bad)).toEqual(resolveTaskBoardLayout(undefined))
    }
  })

  it("drops stale ids and appends statuses a stored layout never mentioned", () => {
    const layout = parseTaskBoardLayout({ columnOrder: ["DONE", "GONE", "TODO"], pinnedColumnIds: ["GONE", "DONE"], activePinnedId: "GONE" })
    expect(layout.columnOrder).toEqual(["DONE", "TODO", "BACKLOG", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "CANCELLED"])
    expect(layout.pinnedColumnIds).toEqual(["DONE"])
    expect(layout.activePinnedId).toBe("DONE")
  })

  it("keeps a pinned CANCELLED in the layout (the board decides whether to render it)", () => {
    const layout = pinColumn(resolveTaskBoardLayout(undefined), "CANCELLED")
    expect(parseTaskBoardLayout(serializeTaskBoardLayout(layout)).pinnedColumnIds).toEqual(["CANCELLED"])
  })

  it("compares an absent layout and an explicit default layout as equal", () => {
    expect(taskBoardLayoutKey(undefined)).toBe(taskBoardLayoutKey(resolveTaskBoardLayout(undefined)))
    expect(taskBoardLayoutKey(pinColumn(resolveTaskBoardLayout(undefined), "DONE"))).not.toBe(taskBoardLayoutKey(undefined))
  })

  it("keeps the pinned tab order equal to the column order when a column moves", () => {
    const two = pinColumn(pinColumn(resolveTaskBoardLayout(undefined), "DONE"), "BLOCKED")
    expect(two.columnOrder.filter((id) => two.pinnedColumnIds.includes(id))).toEqual(["BLOCKED", "DONE"])
    const swapped = moveColumn(two, "DONE", "left")
    expect(swapped.columnOrder.slice(2, 5)).toEqual(["IN_PROGRESS", "DONE", "BLOCKED"])
  })
})
