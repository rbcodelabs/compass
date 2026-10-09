/**
 * Saved roadmap views: the filter + display document, its validation, and its
 * URL round-trip. Pure (no database, no React) so the server page, the server
 * actions and the client filter bar all share one definition.
 *
 * A view is stored as two JSON documents (`filters`, `display`) validated here on
 * every write AND every read. Reads use the `parse*` helpers below, which never
 * throw: a stored document that no longer parses (a horizon that was removed, a
 * hand-edited row) degrades to the default rather than failing the page.
 */
import { z } from "zod"
import type { RoadmapDeliveryStatus } from "@/lib/roadmap-delivery-status"

export const ROADMAP_HORIZONS = ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"] as const
export const ROADMAP_DELIVERY_STATUSES = ["NOT_STARTED", "IN_DEVELOPMENT", "IN_REVIEW", "BLOCKED", "COMPLETE"] as const satisfies readonly RoadmapDeliveryStatus[]
export const ROADMAP_LINK_FILTERS = ["linked", "unlinked"] as const
export const ROADMAP_VIEW_VISIBILITIES = ["PERSONAL", "SHARED"] as const
export const ROADMAP_VIEW_MODES = ["board", "timeline"] as const
export const ROADMAP_VIEW_GROUPINGS = ["horizon", "workspace", "squad", "none"] as const
export const ROADMAP_VIEW_SORTS = ["manual", "startDate", "endDate", "title", "updated"] as const

export const MAX_VIEW_NAME_LENGTH = 120
/** Upper bound on any id list in a stored filter; keeps a saved row (and the query built from it) small. */
export const MAX_FILTER_IDS = 100

const uuid = z.string().uuid()
const idList = z.array(uuid).max(MAX_FILTER_IDS)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "Invalid date")

export const roadmapViewFiltersSchema = z
  .object({
    /** Empty = every workspace the viewer can read. Ids the viewer cannot read are ignored at query time. */
    workspaceIds: idList.default([]),
    horizons: z.array(z.enum(ROADMAP_HORIZONS)).max(ROADMAP_HORIZONS.length).default([]),
    squadIds: idList.default([]),
    deliveryStatuses: z.array(z.enum(ROADMAP_DELIVERY_STATUSES)).max(ROADMAP_DELIVERY_STATUSES.length).default([]),
    /** Items whose [startDate, endDate] window overlaps [dateFrom, dateTo]. Undated items never match a date filter. */
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    /** Whether the item is linked to a key result / to a solution. Omitted = don't care. */
    keyResult: z.enum(ROADMAP_LINK_FILTERS).optional(),
    solution: z.enum(ROADMAP_LINK_FILTERS).optional(),
    /** Workspace roadmaps only: one picklist custom-field value (the per-workspace `?field=&fieldValue=` filter). Ignored by the cross-workspace roadmap, which has no shared field definitions. */
    customField: z.object({ fieldId: uuid, value: z.string().min(1).max(200) }).optional(),
  })
  .refine((f) => !f.dateFrom || !f.dateTo || f.dateFrom <= f.dateTo, { message: "dateFrom must not be after dateTo", path: ["dateTo"] })

export type RoadmapViewFilters = z.infer<typeof roadmapViewFiltersSchema>

export const roadmapViewDisplaySchema = z.object({
  view: z.enum(ROADMAP_VIEW_MODES).default("board"),
  groupBy: z.enum(ROADMAP_VIEW_GROUPINGS).default("horizon"),
  sort: z.enum(ROADMAP_VIEW_SORTS).default("manual"),
  /** Workspace roadmaps only: group by this SELECT custom field instead of `groupBy`. */
  groupField: uuid.optional(),
})

export type RoadmapViewDisplay = z.infer<typeof roadmapViewDisplaySchema>

export const DEFAULT_ROADMAP_FILTERS: RoadmapViewFilters = roadmapViewFiltersSchema.parse({})
export const DEFAULT_ROADMAP_DISPLAY: RoadmapViewDisplay = roadmapViewDisplaySchema.parse({})

/** Validation for a create/update payload. The caller supplies the surface (org vs workspace) separately. */
export const roadmapViewInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(MAX_VIEW_NAME_LENGTH),
  visibility: z.enum(ROADMAP_VIEW_VISIBILITIES).default("PERSONAL"),
  filters: roadmapViewFiltersSchema,
  display: roadmapViewDisplaySchema,
})

export type RoadmapViewInput = z.infer<typeof roadmapViewInputSchema>

/** Read-side parse: never throws, falls back to the default on any invalid document. */
export function parseStoredFilters(raw: unknown): RoadmapViewFilters {
  const result = roadmapViewFiltersSchema.safeParse(raw ?? {})
  return result.success ? result.data : DEFAULT_ROADMAP_FILTERS
}

export function parseStoredDisplay(raw: unknown): RoadmapViewDisplay {
  const result = roadmapViewDisplaySchema.safeParse(raw ?? {})
  return result.success ? result.data : DEFAULT_ROADMAP_DISPLAY
}

/* ------------------------------------------------------------------ URL round-trip */

/**
 * The URL is the live, unsaved filter state (the same convention as the
 * per-workspace roadmap, which keeps `?squad=` etc. in the query string). A saved
 * view is just a named snapshot of it: picking a view navigates to `?view=<id>`,
 * and any further edit to a filter adds explicit params that override the view.
 * Lists are comma-joined; default values are omitted.
 */
export const ROADMAP_URL_PARAMS = {
  savedView: "saved",
  /** "1" = the URL carries the FULL state and the saved view's own values must not be layered under it (needed so a filter can be cleared on top of a saved view). */
  edited: "edited",
  workspaces: "workspaces",
  horizons: "horizons",
  squads: "squads",
  statuses: "statuses",
  dateFrom: "from",
  dateTo: "to",
  keyResult: "kr",
  solution: "solution",
  mode: "view",
  groupBy: "groupBy",
  sort: "sort",
} as const

export type RawSearchParams = Record<string, string | string[] | undefined>

function first(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === "" ? undefined : value
}

function list(raw: string | string[] | undefined): string[] {
  const value = first(raw)
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []
}

function keepValid<T extends string>(values: string[], allowed: readonly T[]): T[] {
  return values.filter((v): v is T => (allowed as readonly string[]).includes(v))
}

/** True when the URL carries any explicit filter/display param (i.e. it overrides a saved view). */
export function hasExplicitRoadmapParams(params: RawSearchParams): boolean {
  return Object.entries(ROADMAP_URL_PARAMS).some(([key, name]) => key !== "savedView" && key !== "edited" && first(params[name]) !== undefined)
}

/**
 * Reads the explicit params off the URL, layered over `base` (the selected saved
 * view, or the defaults). Invalid tokens are dropped individually, so a stale link
 * keeps whatever still parses instead of discarding the whole filter.
 */
export function parseRoadmapParams(
  params: RawSearchParams,
  base: { filters: RoadmapViewFilters; display: RoadmapViewDisplay } = { filters: DEFAULT_ROADMAP_FILTERS, display: DEFAULT_ROADMAP_DISPLAY },
): { filters: RoadmapViewFilters; display: RoadmapViewDisplay } {
  const p = ROADMAP_URL_PARAMS
  const filters: RoadmapViewFilters = { ...base.filters }
  const display: RoadmapViewDisplay = { ...base.display }

  const has = (name: string) => first(params[name]) !== undefined
  const uuids = (name: string) => list(params[name]).filter((v) => uuid.safeParse(v).success).slice(0, MAX_FILTER_IDS)

  if (has(p.workspaces)) filters.workspaceIds = uuids(p.workspaces)
  if (has(p.horizons)) filters.horizons = keepValid(list(params[p.horizons]), ROADMAP_HORIZONS)
  if (has(p.squads)) filters.squadIds = uuids(p.squads)
  if (has(p.statuses)) filters.deliveryStatuses = keepValid(list(params[p.statuses]), ROADMAP_DELIVERY_STATUSES)
  if (has(p.dateFrom)) {
    const parsed = isoDate.safeParse(first(params[p.dateFrom]))
    filters.dateFrom = parsed.success ? parsed.data : undefined
  }
  if (has(p.dateTo)) {
    const parsed = isoDate.safeParse(first(params[p.dateTo]))
    filters.dateTo = parsed.success ? parsed.data : undefined
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) filters.dateTo = undefined
  if (has(p.keyResult)) filters.keyResult = keepValid([first(params[p.keyResult])!], ROADMAP_LINK_FILTERS)[0]
  if (has(p.solution)) filters.solution = keepValid([first(params[p.solution])!], ROADMAP_LINK_FILTERS)[0]

  if (has(p.mode)) display.view = keepValid([first(params[p.mode])!], ROADMAP_VIEW_MODES)[0] ?? base.display.view
  if (has(p.groupBy)) display.groupBy = keepValid([first(params[p.groupBy])!], ROADMAP_VIEW_GROUPINGS)[0] ?? base.display.groupBy
  if (has(p.sort)) display.sort = keepValid([first(params[p.sort])!], ROADMAP_VIEW_SORTS)[0] ?? base.display.sort

  return { filters, display }
}

/**
 * Serializes a filter + display pair to URL params, omitting defaults so a bare
 * roadmap keeps a bare URL. Inverse of {@link parseRoadmapParams} over the default base.
 */
export function roadmapStateToParams(state: { filters: RoadmapViewFilters; display: RoadmapViewDisplay }): URLSearchParams {
  const p = ROADMAP_URL_PARAMS
  const out = new URLSearchParams()
  const { filters: f, display: d } = state
  if (f.workspaceIds.length) out.set(p.workspaces, f.workspaceIds.join(","))
  if (f.horizons.length) out.set(p.horizons, f.horizons.join(","))
  if (f.squadIds.length) out.set(p.squads, f.squadIds.join(","))
  if (f.deliveryStatuses.length) out.set(p.statuses, f.deliveryStatuses.join(","))
  if (f.dateFrom) out.set(p.dateFrom, f.dateFrom)
  if (f.dateTo) out.set(p.dateTo, f.dateTo)
  if (f.keyResult) out.set(p.keyResult, f.keyResult)
  if (f.solution) out.set(p.solution, f.solution)
  if (d.view !== DEFAULT_ROADMAP_DISPLAY.view) out.set(p.mode, d.view)
  if (d.groupBy !== DEFAULT_ROADMAP_DISPLAY.groupBy) out.set(p.groupBy, d.groupBy)
  if (d.sort !== DEFAULT_ROADMAP_DISPLAY.sort) out.set(p.sort, d.sort)
  return out
}

/** Stable, order-insensitive identity of a filter + display pair; used as a remount key and for "is this view modified?". */
export function roadmapStateKey(state: { filters: RoadmapViewFilters; display: RoadmapViewDisplay }): string {
  const f = state.filters
  const sorted = (xs: readonly string[]) => [...xs].sort()
  return JSON.stringify([
    sorted(f.workspaceIds), sorted(f.horizons), sorted(f.squadIds), sorted(f.deliveryStatuses),
    f.dateFrom ?? null, f.dateTo ?? null, f.keyResult ?? null, f.solution ?? null,
    f.customField ? [f.customField.fieldId, f.customField.value] : null,
    state.display.view, state.display.groupBy, state.display.sort, state.display.groupField ?? null,
  ])
}

/** Count of active filters, for the "Filters (3)" badge. Display options are not filters. */
export function countActiveFilters(f: RoadmapViewFilters): number {
  return (
    (f.workspaceIds.length ? 1 : 0) + (f.horizons.length ? 1 : 0) + (f.squadIds.length ? 1 : 0) +
    (f.deliveryStatuses.length ? 1 : 0) + (f.dateFrom || f.dateTo ? 1 : 0) + (f.keyResult ? 1 : 0) + (f.solution ? 1 : 0) + (f.customField ? 1 : 0)
  )
}

/* ------------------------------------------------------------------ saved view + URL resolution */

type RoadmapState = { filters: RoadmapViewFilters; display: RoadmapViewDisplay }

/**
 * The state a URL resolves to. A saved view supplies the base unless the URL is an
 * `edited=1` snapshot (the toolbar writes the FULL state once the user changes
 * anything, because a cleared filter is otherwise indistinguishable from "use the
 * saved view's value"). Explicit params always win over the base.
 */
export function resolveRoadmapState(params: RawSearchParams, saved: RoadmapState | null): RoadmapState {
  const edited = first(params[ROADMAP_URL_PARAMS.edited]) === "1"
  return parseRoadmapParams(params, saved && !edited ? saved : undefined)
}

/**
 * The href that renders `state`. With a `savedViewId` the id is kept so the toolbar
 * still knows which view is being modified; `edited=1` is added only when `state`
 * differs from that view (so re-selecting the saved values yields the clean link).
 */
export function roadmapHref(basePath: string, state: RoadmapState, options: { savedViewId?: string | null; savedState?: RoadmapState | null } = {}): string {
  const params = new URLSearchParams()
  const { savedViewId, savedState } = options
  if (savedViewId && savedState && roadmapStateKey(savedState) === roadmapStateKey(state)) {
    params.set(ROADMAP_URL_PARAMS.savedView, savedViewId)
  } else {
    for (const [k, v] of roadmapStateToParams(state)) params.set(k, v)
    if (savedViewId) {
      params.set(ROADMAP_URL_PARAMS.savedView, savedViewId)
      params.set(ROADMAP_URL_PARAMS.edited, "1")
    }
  }
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}
