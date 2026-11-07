import { describe, expect, it } from "vitest"
import { pinColumn } from "@/lib/board-layout"
import { parseStoredDisplayFor, parseStoredFiltersFor, savedViewInputSchemaFor } from "@/lib/saved-views/schema"
import { SAVED_VIEW_SURFACES, SURFACES, isConsistentScope } from "@/lib/saved-views/surfaces"
import {
  DEFAULT_TASKS_STATE, isTasksStateModified, needsTasksViewExpansion, resolveTasksState, tasksHref, tasksPageParams,
  tasksStateToParams, withLiveColumnLayout, type TasksState,
} from "@/lib/saved-views/tasks-state"
import { resolveTaskBoardLayout } from "@/lib/tasks/board-layout"

const SQUAD = "11111111-1111-4111-8111-111111111111"
const SQUAD_2 = "22222222-2222-4222-8222-222222222222"
const FIELD = "33333333-3333-4333-8333-333333333333"
const USER = "44444444-4444-4444-8444-444444444444"

const DEFAULT_LAYOUT = resolveTaskBoardLayout(undefined)
const PINNED_DONE = pinColumn(DEFAULT_LAYOUT, "DONE")

function savedState(over: Partial<TasksState["filters"]> = {}, display: Partial<TasksState["display"]> = {}): TasksState {
  return {
    filters: { includeAgentTasks: false, squadId: SQUAD, priority: "HIGH", ...over },
    display: { ...DEFAULT_TASKS_STATE.display, ...display },
  }
}

describe("TASKS_BOARD surface registration", () => {
  it("is a workspace-scoped, personal-only surface with unique names, like the other boards", () => {
    expect(SAVED_VIEW_SURFACES).toContain("TASKS_BOARD")
    expect(SURFACES.TASKS_BOARD).toMatchObject({ workspaceScoped: true, sharing: false, uniqueNames: true })
    expect(isConsistentScope("TASKS_BOARD", "ws")).toBe(true)
    expect(isConsistentScope("TASKS_BOARD", null)).toBe(false)
  })
})

describe("resolveTasksState precedence", () => {
  it("falls back to defaults with no params and no view", () => {
    expect(resolveTasksState({}, null)).toEqual(DEFAULT_TASKS_STATE)
  })

  it("layers the saved view under an un-edited URL", () => {
    const state = resolveTasksState({ saved: "v1" }, savedState())
    expect(state.filters.squadId).toBe(SQUAD)
    expect(state.filters.priority).toBe("HIGH")
  })

  it("lets explicit URL params win over the saved view", () => {
    const state = resolveTasksState({ saved: "v1", squad: SQUAD_2, priority: "LOW" }, savedState())
    expect(state.filters.squadId).toBe(SQUAD_2)
    expect(state.filters.priority).toBe("LOW")
  })

  it("ignores the saved view once edited=1", () => {
    expect(resolveTasksState({ saved: "v1", edited: "1" }, savedState())).toEqual(DEFAULT_TASKS_STATE)
  })

  it("drops invalid tokens individually", () => {
    const state = resolveTasksState({ squad: "not-a-uuid", priority: "SOON", view: "kanban", field: "nope", fieldValue: "x" }, null)
    expect(state).toEqual(DEFAULT_TASKS_STATE)
  })

  it("canonicalises a bare assignee id to user:<id> and keeps the unassigned sentinel and agents", () => {
    expect(resolveTasksState({ assignee: USER }, null).filters.assignee).toBe(`user:${USER}`)
    expect(resolveTasksState({ assignee: `agent:${USER}` }, null).filters.assignee).toBe(`agent:${USER}`)
    expect(resolveTasksState({ assignee: "__unassigned__" }, null).filters.assignee).toBe("__unassigned__")
  })

  it("clears a saved filter with an empty param value", () => {
    expect(resolveTasksState({ saved: "v1", priority: "" }, savedState()).filters.priority).toBeUndefined()
  })

  it("reads agentTasks=include and the List view", () => {
    const state = resolveTasksState({ agentTasks: "include", view: "list" }, null)
    expect(state.filters.includeAgentTasks).toBe(true)
    expect(state.display.view).toBe("list")
    expect(resolveTasksState({ agentTasks: "yes" }, null).filters.includeAgentTasks).toBe(false)
  })
})

describe("URL round trip", () => {
  it("omits default values", () => {
    expect(tasksStateToParams(DEFAULT_TASKS_STATE).toString()).toBe("")
  })

  it("round-trips a full state through params", () => {
    const state: TasksState = {
      filters: {
        includeAgentTasks: true, squadId: SQUAD, assignee: `user:${USER}`, priority: "URGENT",
        customField: { fieldId: FIELD, value: "payments" },
      },
      display: { view: "list" },
    }
    const params = Object.fromEntries(tasksStateToParams(state).entries())
    expect(resolveTasksState(params, null)).toEqual(state)
  })

  it("builds the full edited=1 href for a selected saved view", () => {
    expect(tasksHref("/org/ws/tasks", DEFAULT_TASKS_STATE, "view-1")).toBe("/org/ws/tasks?saved=view-1&edited=1")
    expect(tasksHref("/org/ws/tasks", DEFAULT_TASKS_STATE)).toBe("/org/ws/tasks")
    expect(tasksHref("/org/ws/tasks", savedState(), "v1")).toBe(`/org/ws/tasks?squad=${SQUAD}&priority=HIGH&saved=v1&edited=1`)
  })

  it("expands only a bare saved id", () => {
    expect(needsTasksViewExpansion({ saved: "v1" })).toBe(true)
    expect(needsTasksViewExpansion({ saved: "v1", edited: "1" })).toBe(false)
    expect(needsTasksViewExpansion({})).toBe(false)
  })

  it("reads page params back for the queries", () => {
    const page = tasksPageParams(resolveTasksState({ squad: SQUAD, assignee: USER, agentTasks: "include", view: "list" }, null))
    expect(page).toMatchObject({ squad: SQUAD, assignee: `user:${USER}`, includeAgentTasks: true, view: "list", priority: undefined, field: undefined })
  })
})

describe("modified detection, including the effective layout", () => {
  it("is not modified when the URL equals the saved state and the layout is the default", () => {
    const saved = savedState()
    const url = resolveTasksState({ saved: "v1", edited: "1", squad: SQUAD, priority: "HIGH" }, saved)
    expect(isTasksStateModified(withLiveColumnLayout(url, DEFAULT_LAYOUT), saved)).toBe(false)
  })

  it("is modified when a filter changes", () => {
    const saved = savedState()
    expect(isTasksStateModified(resolveTasksState({ saved: "v1", priority: "LOW" }, saved), saved)).toBe(true)
  })

  it("is modified once the live layout differs from the saved one, and not when it matches", () => {
    const saved = savedState()
    const url = resolveTasksState({ saved: "v1" }, saved)
    expect(isTasksStateModified(withLiveColumnLayout(url, PINNED_DONE), saved)).toBe(true)
    const savedWithLayout = savedState({}, { columnLayout: PINNED_DONE })
    expect(isTasksStateModified(withLiveColumnLayout(resolveTasksState({ saved: "v1" }, savedWithLayout), PINNED_DONE), savedWithLayout)).toBe(false)
    expect(isTasksStateModified(withLiveColumnLayout(resolveTasksState({ saved: "v1" }, savedWithLayout), DEFAULT_LAYOUT), savedWithLayout)).toBe(true)
  })

  it("treats an absent saved layout and an explicit default layout as the same", () => {
    const saved = savedState({}, { columnLayout: DEFAULT_LAYOUT })
    expect(isTasksStateModified(withLiveColumnLayout(resolveTasksState({ saved: "v1" }, saved), undefined), saved)).toBe(false)
  })

  it("is never modified without a saved view", () => {
    expect(isTasksStateModified(withLiveColumnLayout(DEFAULT_TASKS_STATE, PINNED_DONE), null)).toBe(false)
  })
})

describe("withLiveColumnLayout (what Save captures)", () => {
  it("serializes the default layout as undefined and folds in a non-default one", () => {
    expect(withLiveColumnLayout(DEFAULT_TASKS_STATE, DEFAULT_LAYOUT).display.columnLayout).toBeUndefined()
    expect(withLiveColumnLayout(DEFAULT_TASKS_STATE, undefined).display.columnLayout).toBeUndefined()
    expect(withLiveColumnLayout(DEFAULT_TASKS_STATE, PINNED_DONE).display.columnLayout).toEqual(PINNED_DONE)
  })

  it("keeps the filters untouched", () => {
    const state = savedState()
    expect(withLiveColumnLayout(state, PINNED_DONE).filters).toEqual(state.filters)
  })
})

describe("saved-view schema for the Tasks board", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: "Mine",
    filters: { squadId: SQUAD, priority: "HIGH", includeAgentTasks: true },
    display: { view: "board", columnLayout: PINNED_DONE },
    ...over,
  })

  it("accepts filters, view and a layout on create/update", () => {
    expect(savedViewInputSchemaFor("TASKS_BOARD").safeParse(body()).success).toBe(true)
    expect(savedViewInputSchemaFor("TASKS_BOARD").safeParse({ name: "Empty", filters: {}, display: {} }).success).toBe(true)
  })

  it("rejects bad filters strictly on write", () => {
    for (const filters of [{ squadId: "nope" }, { priority: "SOON" }, { assignee: "" }, { customField: { fieldId: "x", value: "v" } }]) {
      expect(savedViewInputSchemaFor("TASKS_BOARD").safeParse(body({ filters })).success).toBe(false)
    }
    expect(savedViewInputSchemaFor("TASKS_BOARD").safeParse(body({ display: { view: "table" } })).success).toBe(false)
  })

  it("is not the board schema of another surface", () => {
    // Opportunities' filters (squadIds) are not Tasks filters: unknown keys are stripped, so they never leak across surfaces.
    expect(parseStoredFiltersFor("TASKS_BOARD", { squadIds: [SQUAD] })).toEqual({ includeAgentTasks: false })
    expect(savedViewInputSchemaFor("OPPORTUNITIES_BOARD").safeParse(body()).success).toBe(false)
  })

  it("an untouched document stays byte-identical (no columnLayout key written for the default)", () => {
    expect(JSON.stringify(parseStoredDisplayFor("TASKS_BOARD", {}))).toBe(JSON.stringify({ view: "board" }))
  })

  it("keeps a valid layout on read", () => {
    expect((parseStoredDisplayFor("TASKS_BOARD", { columnLayout: PINNED_DONE }) as TasksState["display"]).columnLayout).toEqual(PINNED_DONE)
  })

  it("degrades a corrupt layout to absent without taking the rest of the display down (.catch)", () => {
    const display = parseStoredDisplayFor("TASKS_BOARD", { view: "list", columnLayout: { columnOrder: 5, pinnedColumnIds: "x" } }) as TasksState["display"]
    expect(display.columnLayout).toBeUndefined()
    expect(display.view).toBe("list")
    expect((parseStoredDisplayFor("TASKS_BOARD", { columnLayout: "garbage" }) as TasksState["display"]).columnLayout).toBeUndefined()
  })

  it("degrades an unreadable filters document to the default filters (never throws)", () => {
    expect(parseStoredFiltersFor("TASKS_BOARD", { squadId: 7 })).toEqual({ includeAgentTasks: false })
    expect(parseStoredFiltersFor("TASKS_BOARD", null)).toEqual({ includeAgentTasks: false })
  })
})
