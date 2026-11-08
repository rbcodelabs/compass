import { describe, expect, it } from "vitest"
import { moveColumn, pinColumn } from "@/lib/board-layout"
import {
  EXPERIMENT_BOARD_LAYOUT_DEFAULTS,
  EXPERIMENT_BOARD_STATUSES,
  parseExperimentBoardLayout,
  resolveExperimentBoardLayout,
  serializeExperimentBoardLayout,
} from "@/lib/experiments/board-layout"

describe("Experiments board layout binding", () => {
  it("knows every status column in lifecycle order", () => {
    expect([...EXPERIMENT_BOARD_STATUSES]).toEqual(["DESIGNING", "RUNNING", "COMPLETE", "KILLED"])
  })

  it("starts with nothing pinned, no active tab and the dock collapsed", () => {
    expect(resolveExperimentBoardLayout(undefined)).toEqual({
      columnOrder: [...EXPERIMENT_BOARD_STATUSES],
      pinnedColumnIds: [],
      activePinnedId: null,
      dockCollapsed: true,
    })
    expect(EXPERIMENT_BOARD_LAYOUT_DEFAULTS.pinned).toEqual([])
  })

  it("serializes the default layout as undefined and a pinned layout in full, round-tripping it", () => {
    expect(serializeExperimentBoardLayout(resolveExperimentBoardLayout(undefined))).toBeUndefined()
    const pinned = pinColumn(resolveExperimentBoardLayout(undefined), "KILLED")
    const stored = serializeExperimentBoardLayout(pinned)
    expect(stored).toEqual({ columnOrder: [...EXPERIMENT_BOARD_STATUSES], pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false })
    expect(parseExperimentBoardLayout(stored)).toEqual(pinned)
  })

  it("degrades corrupt input to the defaults", () => {
    for (const bad of [null, "nope", 7, {}, { columnOrder: "x", pinnedColumnIds: [] }, { columnOrder: [], pinnedColumnIds: [3] }]) {
      expect(parseExperimentBoardLayout(bad)).toEqual(resolveExperimentBoardLayout(undefined))
    }
  })

  it("drops stale ids and appends statuses a stored layout never mentioned", () => {
    const layout = parseExperimentBoardLayout({ columnOrder: ["KILLED", "GONE", "RUNNING"], pinnedColumnIds: ["GONE", "KILLED"], activePinnedId: "GONE" })
    expect(layout.columnOrder).toEqual(["KILLED", "RUNNING", "DESIGNING", "COMPLETE"])
    expect(layout.pinnedColumnIds).toEqual(["KILLED"])
    expect(layout.activePinnedId).toBe("KILLED")
  })

  it("keeps the tab order equal to the column order when a column moves", () => {
    const two = pinColumn(pinColumn(resolveExperimentBoardLayout(undefined), "KILLED"), "RUNNING")
    expect(two.columnOrder.filter((id) => two.pinnedColumnIds.includes(id))).toEqual(["RUNNING", "KILLED"])
    expect(moveColumn(two, "KILLED", "left").columnOrder).toEqual(["DESIGNING", "KILLED", "COMPLETE", "RUNNING"])
  })
})
