/**
 * The Solutions board live state (filters + display) and its URL round-trip, the
 * Solutions counterpart of opportunities-state.ts with the same precedence:
 *   1. explicit URL params (squad, field, fieldValue, view, groupBy, sort, order, hide)
 *   2. the selected saved view (saved=id), unless the URL is an edited=1 snapshot
 *   3. built-in defaults (active-work-first column order)
 *
 * groupBy in the URL is "status" (omitted), "squad", "opportunity" or field:id; it is
 * stored as "status", "squad", "opportunity" or the bare field id.
 */
import { z } from "zod"
import { DEFAULT_SOLUTION_COLUMN_ORDER, resolveColumns, type ColumnLayout } from "@/lib/saved-views/columns"
import { OPPORTUNITIES_URL_PARAMS, type RawSearchParams } from "@/lib/saved-views/opportunities-state"
import { SOLUTION_BOARD_STATUSES, type BoardViewDisplay, type BoardViewFilters } from "@/lib/saved-views/schema"

export type SolutionsState = { filters: BoardViewFilters; display: BoardViewDisplay }

/** Same vocabulary as the Opportunities board, so the shared header controls work unchanged. */
export const SOLUTIONS_URL_PARAMS = OPPORTUNITIES_URL_PARAMS

const FIELD_PREFIX = "field:"
const uuid = z.string().uuid()
const STATUS_KEYS: readonly string[] = SOLUTION_BOARD_STATUSES
const DEFAULT_ORDER: readonly string[] = DEFAULT_SOLUTION_COLUMN_ORDER

export const DEFAULT_SOLUTIONS_STATE: SolutionsState = {
  filters: { squadIds: [] },
  display: { view: "board", groupBy: "status", sort: "manual", columns: {} },
}

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

function parseStatusList(raw: string): string[] {
  return [...new Set(raw.split(",").map((token) => token.trim()).filter((token) => STATUS_KEYS.includes(token)))]
}

function isDefaultOrder(order: readonly string[]): boolean {
  return order.every((key, i) => key === DEFAULT_ORDER[i])
}

/** Canonical stored form of the status layout; undefined when it equals the default. */
export function normalizeSolutionStatusLayout(layout: Partial<ColumnLayout> | undefined): ColumnLayout | undefined {
  const { order } = resolveColumns(layout, STATUS_KEYS, DEFAULT_ORDER, {})
  const hiddenSet = new Set(layout?.hidden ?? [])
  const hidden = order.filter((key) => hiddenSet.has(key))
  return isDefaultOrder(order) && hidden.length === 0 ? undefined : { order, hidden }
}

function withStatusLayout(display: BoardViewDisplay, layout: Partial<ColumnLayout> | undefined): BoardViewDisplay {
  const otherGroupings = Object.fromEntries(Object.entries(display.columns).filter(([groupKey]) => groupKey !== "status"))
  const status = normalizeSolutionStatusLayout(layout)
  return { ...display, columns: status ? { ...otherGroupings, status } : otherGroupings }
}

export function normalizeSolutionsState(state: SolutionsState): SolutionsState {
  return { filters: state.filters, display: withStatusLayout(state.display, state.display.columns.status) }
}

export function resolveSolutionsState(params: RawSearchParams, saved: SolutionsState | null): SolutionsState {
  const p = SOLUTIONS_URL_PARAMS
  const edited = first(params[p.edited]) === "1"
  const base = saved && !edited ? normalizeSolutionsState(saved) : DEFAULT_SOLUTIONS_STATE
  const filters: BoardViewFilters = { ...base.filters }
  const display: BoardViewDisplay = { ...base.display }

  const squad = first(params[p.squad])
  if (squad !== undefined) filters.squadIds = uuid.safeParse(squad).success ? [squad] : []

  const field = first(params[p.field])
  const fieldValue = first(params[p.fieldValue])
  if (field !== undefined || fieldValue !== undefined) {
    filters.customField = field && fieldValue && uuid.safeParse(field).success ? { fieldId: field, value: fieldValue.slice(0, 200) } : undefined
  }

  const view = first(params[p.view])
  if (view !== undefined) display.view = view === "table" ? "table" : "board"

  const groupBy = first(params[p.groupBy])
  if (groupBy !== undefined) {
    const fieldId = groupBy.startsWith(FIELD_PREFIX) ? groupBy.slice(FIELD_PREFIX.length) : ""
    if (groupBy === "squad" || groupBy === "opportunity") display.groupBy = groupBy
    else display.groupBy = uuid.safeParse(fieldId).success ? fieldId : "status"
  }

  const sort = first(params[p.sort])
  if (sort !== undefined) display.sort = sort === "score" ? "score" : "manual"

  const order = first(params[p.order])
  const hide = first(params[p.hide])
  const baseLayout = base.display.columns.status
  const layout: Partial<ColumnLayout> = {
    order: order !== undefined ? parseStatusList(order) : baseLayout?.order,
    hidden: hide !== undefined ? parseStatusList(hide) : baseLayout?.hidden,
  }
  return { filters, display: withStatusLayout(display, layout) }
}

/** The page params for a state: default values are omitted. */
export function solutionsStateToParams(state: SolutionsState): URLSearchParams {
  const p = SOLUTIONS_URL_PARAMS
  const out = new URLSearchParams()
  const { filters, display } = state
  if (filters.squadIds[0]) out.set(p.squad, filters.squadIds[0])
  if (filters.customField) {
    out.set(p.field, filters.customField.fieldId)
    out.set(p.fieldValue, filters.customField.value)
  }
  if (display.view === "table") out.set(p.view, "table")
  if (display.groupBy === "squad" || display.groupBy === "opportunity") out.set(p.groupBy, display.groupBy)
  else if (display.groupBy !== "status") out.set(p.groupBy, FIELD_PREFIX + display.groupBy)
  if (display.sort === "score") out.set(p.sort, "score")
  const layout = normalizeSolutionStatusLayout(display.columns.status)
  if (layout) {
    if (!isDefaultOrder(layout.order)) out.set(p.order, layout.order.join(","))
    if (layout.hidden.length > 0) out.set(p.hide, layout.hidden.join(","))
  }
  return out
}

/** The href that renders state with savedViewId still selected (full edited=1 form). */
export function solutionsHref(basePath: string, state: SolutionsState, savedViewId?: string | null): string {
  const params = solutionsStateToParams(state)
  if (savedViewId) {
    params.set(SOLUTIONS_URL_PARAMS.savedView, savedViewId)
    params.set(SOLUTIONS_URL_PARAMS.edited, "1")
  }
  const query = params.toString()
  return query ? basePath + "?" + query : basePath
}

/** True when a bare saved=id (no edited) needs expanding into the full URL. */
export function needsSolutionsViewExpansion(params: RawSearchParams): boolean {
  return first(params[SOLUTIONS_URL_PARAMS.savedView]) !== undefined && first(params[SOLUTIONS_URL_PARAMS.edited]) !== "1"
}

export function solutionsStateKey(state: SolutionsState): string {
  const layout = normalizeSolutionStatusLayout(state.display.columns.status)
  return JSON.stringify([
    state.filters.squadIds,
    state.filters.customField ? [state.filters.customField.fieldId, state.filters.customField.value] : null,
    state.display.view, state.display.groupBy, state.display.sort,
    layout ? [layout.order, layout.hidden] : null,
  ])
}

export function isSolutionsStateModified(state: SolutionsState, saved: SolutionsState | null): boolean {
  return saved !== null && solutionsStateKey(state) !== solutionsStateKey(saved)
}

/** What the Solutions page reads back off a resolved state, in the URL vocabulary. */
export function solutionsPageParams(state: SolutionsState): {
  squad: string | undefined
  field: string | undefined
  fieldValue: string | undefined
  view: "board" | "table"
  groupBy: string | undefined
  sort: "manual" | "score"
} {
  const params = solutionsStateToParams(state)
  const p = SOLUTIONS_URL_PARAMS
  return {
    squad: params.get(p.squad) ?? undefined,
    field: params.get(p.field) ?? undefined,
    fieldValue: params.get(p.fieldValue) ?? undefined,
    view: state.display.view,
    groupBy: params.get(p.groupBy) ?? undefined,
    sort: state.display.sort,
  }
}
