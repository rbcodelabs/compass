/**
 * The Opportunities board's live state (filters + display) and its URL round-trip:
 * the one pure `resolveSurfaceState` the server page and the client menu share.
 *
 * Precedence, highest first (ADR-0018 section 7):
 *   1. explicit URL params (`squad`, `field`, `fieldValue`, `view`, `groupBy`, `sort`, `order`, `hide`)
 *   2. the selected saved view (`?saved=<id>`), unless the URL is an `edited=1` snapshot
 *   3. built-in defaults (Active-first column order)
 * `edited=1` means the URL carries the FULL state, so a cleared filter stays cleared. A
 * stale or foreign saved id never reaches this file: the caller passes `saved = null`.
 *
 * Column layout lives under `display.columns.status` and is always stored normalized
 * (see {@link normalizeStatusLayout}), so a saved order that only omits a status is not
 * "modified" on first load.
 */
import { z } from "zod"
import { DEFAULT_OPPORTUNITY_COLUMN_ORDER, resolveColumns, type ColumnLayout } from "@/lib/saved-views/columns"
import { OPPORTUNITY_BOARD_STATUSES, type BoardViewDisplay, type BoardViewFilters } from "@/lib/saved-views/schema"

export type OpportunitiesState = { filters: BoardViewFilters; display: BoardViewDisplay }
export type RawSearchParams = Record<string, string | string[] | undefined>

export const OPPORTUNITIES_URL_PARAMS = {
  squad: "squad",
  field: "field",
  fieldValue: "fieldValue",
  view: "view",
  groupBy: "groupBy",
  sort: "sort",
  order: "order",
  hide: "hide",
  savedView: "saved",
  edited: "edited",
} as const

const FIELD_PREFIX = "field:"
const uuid = z.string().uuid()
const STATUS_KEYS: readonly string[] = OPPORTUNITY_BOARD_STATUSES
const DEFAULT_ORDER: readonly string[] = DEFAULT_OPPORTUNITY_COLUMN_ORDER

export const DEFAULT_OPPORTUNITIES_STATE: OpportunitiesState = {
  filters: { squadIds: [] },
  display: { view: "board", groupBy: "status", sort: "manual", columns: {} },
}

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

/** Keeps known statuses only, once each. Invalid tokens are dropped individually so a stale link keeps what still parses. */
function parseStatusList(raw: string): string[] {
  return [...new Set(raw.split(",").map((token) => token.trim()).filter((token) => STATUS_KEYS.includes(token)))]
}

function isDefaultOrder(order: readonly string[]): boolean {
  return order.every((key, i) => key === DEFAULT_ORDER[i])
}

/**
 * The canonical stored form of the status layout: the full resolved order and the known
 * hidden statuses (in order), or undefined when it equals the default. Counts are
 * deliberately not an input: forced visibility is a render-time concern.
 */
export function normalizeStatusLayout(layout: Partial<ColumnLayout> | undefined): ColumnLayout | undefined {
  const { order } = resolveColumns(layout, STATUS_KEYS, DEFAULT_ORDER, {})
  const hiddenSet = new Set(layout?.hidden ?? [])
  const hidden = order.filter((key) => hiddenSet.has(key))
  return isDefaultOrder(order) && hidden.length === 0 ? undefined : { order, hidden }
}

function withStatusLayout(display: BoardViewDisplay, layout: Partial<ColumnLayout> | undefined): BoardViewDisplay {
  const otherGroupings = Object.fromEntries(Object.entries(display.columns).filter(([groupKey]) => groupKey !== "status"))
  const status = normalizeStatusLayout(layout)
  return { ...display, columns: status ? { ...otherGroupings, status } : otherGroupings }
}

/** A stored or parsed state in canonical form. */
export function normalizeOpportunitiesState(state: OpportunitiesState): OpportunitiesState {
  return { filters: state.filters, display: withStatusLayout(state.display, state.display.columns.status) }
}

export function resolveSurfaceState(
  _surface: "OPPORTUNITIES_BOARD",
  params: RawSearchParams,
  saved: OpportunitiesState | null,
): OpportunitiesState {
  const p = OPPORTUNITIES_URL_PARAMS
  const edited = first(params[p.edited]) === "1"
  const base = saved && !edited ? normalizeOpportunitiesState(saved) : DEFAULT_OPPORTUNITIES_STATE
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
    display.groupBy = uuid.safeParse(fieldId).success ? fieldId : "status"
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

/** The page's own params for a state: default values are omitted, like the live controls do. */
export function opportunitiesStateToParams(state: OpportunitiesState): URLSearchParams {
  const p = OPPORTUNITIES_URL_PARAMS
  const out = new URLSearchParams()
  const { filters, display } = state
  if (filters.squadIds[0]) out.set(p.squad, filters.squadIds[0])
  if (filters.customField) {
    out.set(p.field, filters.customField.fieldId)
    out.set(p.fieldValue, filters.customField.value)
  }
  if (display.view === "table") out.set(p.view, "table")
  if (display.groupBy !== "status") out.set(p.groupBy, `${FIELD_PREFIX}${display.groupBy}`)
  if (display.sort === "score") out.set(p.sort, "score")
  const layout = normalizeStatusLayout(display.columns.status)
  if (layout) {
    if (!isDefaultOrder(layout.order)) out.set(p.order, layout.order.join(","))
    if (layout.hidden.length > 0) out.set(p.hide, layout.hidden.join(","))
  }
  return out
}

/**
 * The href that renders `state` with `savedViewId` still selected. With a saved view it is
 * always the full (`edited=1`) form, so later single-param edits never re-layer the view.
 */
export function opportunitiesHref(basePath: string, state: OpportunitiesState, savedViewId?: string | null): string {
  const params = opportunitiesStateToParams(state)
  if (savedViewId) {
    params.set(OPPORTUNITIES_URL_PARAMS.savedView, savedViewId)
    params.set(OPPORTUNITIES_URL_PARAMS.edited, "1")
  }
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

/** True when a bare `?saved=<id>` (no `edited`) needs expanding into the full URL. */
export function needsSavedViewExpansion(params: RawSearchParams): boolean {
  return first(params[OPPORTUNITIES_URL_PARAMS.savedView]) !== undefined && first(params[OPPORTUNITIES_URL_PARAMS.edited]) !== "1"
}

/** Stable identity of a state, for "is this view modified?". Filters are single-valued, so only the layout needs normalizing. */
export function opportunitiesStateKey(state: OpportunitiesState): string {
  const layout = normalizeStatusLayout(state.display.columns.status)
  return JSON.stringify([
    state.filters.squadIds,
    state.filters.customField ? [state.filters.customField.fieldId, state.filters.customField.value] : null,
    state.display.view, state.display.groupBy, state.display.sort,
    layout ? [layout.order, layout.hidden] : null,
  ])
}

export function isOpportunitiesStateModified(state: OpportunitiesState, saved: OpportunitiesState | null): boolean {
  return saved !== null && opportunitiesStateKey(state) !== opportunitiesStateKey(saved)
}

/** What the discovery page reads back off a resolved state, in the URL's own vocabulary. */
export function opportunitiesPageParams(state: OpportunitiesState): {
  squad: string | undefined
  field: string | undefined
  fieldValue: string | undefined
  view: "board" | "table"
  groupBy: string | undefined
  sort: "manual" | "score"
} {
  const params = opportunitiesStateToParams(state)
  return {
    squad: params.get(OPPORTUNITIES_URL_PARAMS.squad) ?? undefined,
    field: params.get(OPPORTUNITIES_URL_PARAMS.field) ?? undefined,
    fieldValue: params.get(OPPORTUNITIES_URL_PARAMS.fieldValue) ?? undefined,
    view: state.display.view,
    groupBy: params.get(OPPORTUNITIES_URL_PARAMS.groupBy) ?? undefined,
    sort: state.display.sort,
  }
}
