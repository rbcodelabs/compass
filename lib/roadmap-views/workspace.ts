/**
 * Saved views on a single workspace's roadmap (`/{org}/{workspace}/roadmap`).
 *
 * The workspace roadmap already keeps its live state in the URL (`?squad=`,
 * `?field=&fieldValue=`, `?groupBy=`, `?view=`). A saved view is a named snapshot of
 * exactly that state, stored in the same document shape as the cross-workspace
 * views so one table, one service and one picker serve both surfaces:
 *
 *   squad                 <-> filters.squadIds (zero or one id; the page filters one squad)
 *   field + fieldValue    <-> filters.customField
 *   groupBy phase|squad|none  <-> display.groupBy horizon|squad|none
 *   groupBy <field id>    <-> display.groupField
 *   view timeline|board   <-> display.view
 *
 * Pure (no database, no React), like schema.ts, so the server page, the client
 * header and the tests share one definition.
 *
 * URL rules match the cross-workspace page: `?saved=<id>` selects a view, explicit
 * params override it, and `edited=1` means the URL carries the FULL state (so a
 * cleared filter stays cleared). The workspace page redirects a bare `?saved=<id>`
 * to that full form, which lets every existing header control keep editing single
 * params with no knowledge of saved views.
 */
import { z } from "zod"
import {
  DEFAULT_ROADMAP_DISPLAY,
  DEFAULT_ROADMAP_FILTERS,
  ROADMAP_URL_PARAMS,
  roadmapStateKey,
  type RawSearchParams,
  type RoadmapViewDisplay,
  type RoadmapViewFilters,
} from "./schema"

type State = { filters: RoadmapViewFilters; display: RoadmapViewDisplay }

const uuid = z.string().uuid()

/** The workspace page's own search params (plus the saved-view selector). */
export const WORKSPACE_URL_PARAMS = {
  squad: "squad",
  field: "field",
  fieldValue: "fieldValue",
  groupBy: "groupBy",
  view: "view",
} as const

function first(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === "" ? undefined : value
}

const DEFAULT_STATE: State = { filters: DEFAULT_ROADMAP_FILTERS, display: DEFAULT_ROADMAP_DISPLAY }

/**
 * The state a workspace-roadmap URL resolves to. The saved view is the base unless
 * the URL is an `edited=1` snapshot; explicit params always win over the base.
 * Invalid tokens are dropped individually (a stale link keeps whatever still parses).
 */
export function resolveWorkspaceRoadmapState(params: RawSearchParams, saved: State | null): State {
  const p = WORKSPACE_URL_PARAMS
  const edited = first(params[ROADMAP_URL_PARAMS.edited]) === "1"
  const base = saved && !edited ? saved : DEFAULT_STATE
  const filters: RoadmapViewFilters = { ...base.filters }
  const display: RoadmapViewDisplay = { ...base.display }

  const squad = first(params[p.squad])
  if (squad !== undefined) filters.squadIds = uuid.safeParse(squad).success ? [squad] : []

  const field = first(params[p.field])
  const fieldValue = first(params[p.fieldValue])
  if (field !== undefined || fieldValue !== undefined) {
    filters.customField = field && fieldValue && uuid.safeParse(field).success ? { fieldId: field, value: fieldValue.slice(0, 200) } : undefined
  }

  const groupBy = first(params[p.groupBy])
  if (groupBy !== undefined) {
    display.groupField = undefined
    if (groupBy === "phase") display.groupBy = "horizon"
    else if (groupBy === "squad" || groupBy === "none") display.groupBy = groupBy
    else if (uuid.safeParse(groupBy).success) {
      display.groupBy = "horizon"
      display.groupField = groupBy
    } else display.groupBy = base.display.groupBy
  }

  const view = first(params[p.view])
  if (view !== undefined) display.view = view === "timeline" ? "timeline" : "board"

  return { filters, display }
}

/** The page's own params for a state: default values are omitted, like the live controls do. */
export function workspaceStateToParams(state: State): URLSearchParams {
  const p = WORKSPACE_URL_PARAMS
  const out = new URLSearchParams()
  const { filters, display } = state
  if (filters.squadIds[0]) out.set(p.squad, filters.squadIds[0])
  if (filters.customField) {
    out.set(p.field, filters.customField.fieldId)
    out.set(p.fieldValue, filters.customField.value)
  }
  if (display.groupField) out.set(p.groupBy, display.groupField)
  else if (display.groupBy === "squad" || display.groupBy === "none") out.set(p.groupBy, display.groupBy)
  if (display.view === "timeline") out.set(p.view, "timeline")
  return out
}

/**
 * The href that renders `state` with `savedViewId` still selected. Always the full
 * (`edited=1`) form; see the module comment.
 */
export function workspaceRoadmapHref(basePath: string, state: State, savedViewId?: string | null): string {
  const params = workspaceStateToParams(state)
  if (savedViewId) {
    params.set(ROADMAP_URL_PARAMS.savedView, savedViewId)
    params.set(ROADMAP_URL_PARAMS.edited, "1")
  }
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

/** The workspace page applies a filter as `?squad=` etc.; these are the values it reads back off a resolved state. */
export function workspacePageParams(state: State): {
  squad: string | undefined
  field: string | undefined
  fieldValue: string | undefined
  groupBy: string | undefined
  view: "board" | "timeline"
} {
  const params = workspaceStateToParams(state)
  return {
    squad: params.get(WORKSPACE_URL_PARAMS.squad) ?? undefined,
    field: params.get(WORKSPACE_URL_PARAMS.field) ?? undefined,
    fieldValue: params.get(WORKSPACE_URL_PARAMS.fieldValue) ?? undefined,
    groupBy: params.get(WORKSPACE_URL_PARAMS.groupBy) ?? undefined,
    view: state.display.view,
  }
}

/** True when a bare `?saved=<id>` (no `edited`) needs expanding into the full URL. */
export function needsSavedViewExpansion(params: RawSearchParams): boolean {
  return first(params[ROADMAP_URL_PARAMS.savedView]) !== undefined && first(params[ROADMAP_URL_PARAMS.edited]) !== "1"
}

export function isWorkspaceStateModified(state: State, saved: State | null): boolean {
  return saved !== null && roadmapStateKey(state) !== roadmapStateKey(saved)
}
