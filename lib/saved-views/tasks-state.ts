/**
 * The Tasks board's live state (filters + display) and its URL round-trip, the Tasks counterpart of solutions-state.ts
 * with the same precedence:
 *   1. explicit URL params (squad, assignee, priority, agentTasks, field, fieldValue, view)
 *   2. the selected saved view (saved=id), unless the URL is an edited=1 snapshot
 *   3. built-in defaults (every filter off, Board view)
 *
 * The URL stays the live state; a saved view is a named snapshot of it. `?saved=<id>` alone means "this view as saved"
 * and the page expands it to the full `edited=1` form, so every control keeps editing single params.
 *
 * The board's column layout (pinned, active tab, dock open, order) is NOT a URL param: it is client state the saved-views
 * menu folds in with {@link withLiveColumnLayout}, which is what Save captures and what "modified" compares.
 */
import type { RawSearchParams } from "@/lib/saved-views/opportunities-state"
import { tasksDisplaySchema, tasksFiltersSchema, type TasksViewDisplay, type TasksViewFilters } from "@/lib/saved-views/schema"
import type { BoardLayout } from "@/lib/board-layout"
import { canonicalAssigneeFilterValue } from "@/lib/task-assignee-display"
import { TASK_PRIORITIES } from "@/lib/task-meta"
import { serializeTaskBoardLayout, taskBoardLayoutKey } from "@/lib/tasks/board-layout"
import { z } from "zod"

export type TasksState = { filters: TasksViewFilters; display: TasksViewDisplay }
export type { TasksViewFilters, TasksViewDisplay }

export const TASKS_URL_PARAMS = {
  squad: "squad",
  assignee: "assignee",
  priority: "priority",
  agentTasks: "agentTasks",
  field: "field",
  fieldValue: "fieldValue",
  view: "view",
  savedView: "saved",
  edited: "edited",
} as const

const uuid = z.string().uuid()
const PRIORITIES: readonly string[] = TASK_PRIORITIES

export const DEFAULT_TASKS_STATE: TasksState = {
  filters: tasksFiltersSchema.parse({}),
  display: tasksDisplaySchema.parse({}),
}

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

/** Drops keys whose value is undefined, so a state compares and serializes the same whether a key was cleared or never set. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function resolveTasksState(params: RawSearchParams, saved: TasksState | null): TasksState {
  const p = TASKS_URL_PARAMS
  const edited = first(params[p.edited]) === "1"
  const base = saved && !edited ? saved : DEFAULT_TASKS_STATE
  const filters: TasksViewFilters = { ...base.filters }
  const display: TasksViewDisplay = { ...base.display }

  const squad = first(params[p.squad])
  if (squad !== undefined) filters.squadId = uuid.safeParse(squad).success ? squad : undefined

  const assignee = first(params[p.assignee])
  if (assignee !== undefined) filters.assignee = canonicalAssigneeFilterValue(assignee)?.slice(0, 200) ?? undefined

  const priority = first(params[p.priority])
  if (priority !== undefined) filters.priority = PRIORITIES.includes(priority) ? (priority as TasksViewFilters["priority"]) : undefined

  const agentTasks = first(params[p.agentTasks])
  if (agentTasks !== undefined) filters.includeAgentTasks = agentTasks === "include"

  const field = first(params[p.field])
  const fieldValue = first(params[p.fieldValue])
  if (field !== undefined || fieldValue !== undefined) {
    filters.customField = field && fieldValue && uuid.safeParse(field).success ? { fieldId: field, value: fieldValue.slice(0, 200) } : undefined
  }

  const view = first(params[p.view])
  if (view !== undefined) display.view = view === "list" ? "list" : "board"

  return { filters: compact(filters), display: compact(display) }
}

/** The page params for a state: default values are omitted. */
export function tasksStateToParams(state: TasksState): URLSearchParams {
  const p = TASKS_URL_PARAMS
  const out = new URLSearchParams()
  const { filters, display } = state
  if (filters.squadId) out.set(p.squad, filters.squadId)
  if (filters.assignee) out.set(p.assignee, filters.assignee)
  if (filters.priority) out.set(p.priority, filters.priority)
  if (filters.includeAgentTasks) out.set(p.agentTasks, "include")
  if (filters.customField) {
    out.set(p.field, filters.customField.fieldId)
    out.set(p.fieldValue, filters.customField.value)
  }
  if (display.view === "list") out.set(p.view, "list")
  return out
}

/** The href that renders state with savedViewId still selected (full edited=1 form). */
export function tasksHref(basePath: string, state: TasksState, savedViewId?: string | null): string {
  const params = tasksStateToParams(state)
  if (savedViewId) {
    params.set(TASKS_URL_PARAMS.savedView, savedViewId)
    params.set(TASKS_URL_PARAMS.edited, "1")
  }
  const query = params.toString()
  return query ? basePath + "?" + query : basePath
}

/** True when a bare saved=id (no edited) needs expanding into the full URL. */
export function needsTasksViewExpansion(params: RawSearchParams): boolean {
  return first(params[TASKS_URL_PARAMS.savedView]) !== undefined && first(params[TASKS_URL_PARAMS.edited]) !== "1"
}

/**
 * The live state with the board's column layout folded in, which is what Save captures and what "modified" compares.
 * The layout is client state (not a URL param), so it is merged in from the store. It is serialized as `undefined` when it
 * is the default, so an untouched board adds nothing to a saved view.
 */
export function withLiveColumnLayout(state: TasksState, layout: BoardLayout | undefined): TasksState {
  const stored = layout ? serializeTaskBoardLayout(layout) : undefined
  return { filters: state.filters, display: compact({ ...state.display, columnLayout: stored }) }
}

export function tasksStateKey(state: TasksState): string {
  const f = state.filters
  return JSON.stringify([
    f.squadId ?? null,
    f.assignee ?? null,
    f.priority ?? null,
    f.includeAgentTasks,
    f.customField ? [f.customField.fieldId, f.customField.value] : null,
    state.display.view,
    // An absent layout is the default layout.
    taskBoardLayoutKey(state.display.columnLayout),
  ])
}

export function isTasksStateModified(state: TasksState, saved: TasksState | null): boolean {
  return saved !== null && tasksStateKey(state) !== tasksStateKey(saved)
}

/** What the Tasks page reads back off a resolved state, in the URL vocabulary the queries use. */
export function tasksPageParams(state: TasksState): {
  squad: string | undefined
  assignee: string | undefined
  priority: string | undefined
  includeAgentTasks: boolean
  field: string | undefined
  fieldValue: string | undefined
  view: "board" | "list"
} {
  return {
    squad: state.filters.squadId,
    assignee: state.filters.assignee,
    priority: state.filters.priority,
    includeAgentTasks: state.filters.includeAgentTasks,
    field: state.filters.customField?.fieldId,
    fieldValue: state.filters.customField?.value,
    view: state.display.view,
  }
}
