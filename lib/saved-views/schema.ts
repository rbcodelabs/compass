/**
 * Per-surface validation of a saved view's `filters` and `display` documents.
 * Writes validate strictly; reads use the never-throw `parseStored*` helpers so a
 * stale document degrades to the surface default instead of failing a page.
 *
 * The two roadmap surfaces reuse the roadmap schemas unchanged
 * (lib/roadmap-views/schema.ts). The board surfaces are defined here.
 */
import { z } from "zod"
import { boardLayoutSchema } from "@/lib/board-layout"
import {
  DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS, MAX_VIEW_NAME_LENGTH, ROADMAP_VIEW_VISIBILITIES,
  roadmapViewDisplaySchema, roadmapViewFiltersSchema,
} from "@/lib/roadmap-views/schema"
import { columnsByGroupSchema } from "@/lib/saved-views/columns"
import type { SavedViewSurface } from "@/lib/saved-views/surfaces"

const uuid = z.string().uuid()

/** Statuses a board column can take. ARCHIVED is not a board column. */
export const OPPORTUNITY_BOARD_STATUSES = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "UNREVIEWED"] as const
export const SOLUTION_BOARD_STATUSES = ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"] as const

/** `columns.status` may only name real statuses; unknown values are dropped (a removed status must not break a view). */
function keepKnownStatuses(statuses: readonly string[]) {
  const known = new Set(statuses)
  return (columns: z.infer<typeof columnsByGroupSchema>) => {
    const status = columns.status
    if (!status) return columns
    return {
      ...columns,
      status: { order: status.order.filter((s) => known.has(s)), hidden: status.hidden.filter((s) => known.has(s)) },
    }
  }
}

const boardFiltersSchema = z.object({
  /** 0 or 1, matching the single `?squad=` the boards have today. */
  squadIds: z.array(uuid).max(1).default([]),
  customField: z.object({ fieldId: uuid, value: z.string().min(1).max(200) }).optional(),
})

function boardDisplaySchema(statuses: readonly string[], extraGroupings: readonly string[] = []) {
  return z.object({
    view: z.enum(["board", "table"]).default("board"),
    /** "status", a surface-specific grouping (Solutions: "squad", "opportunity") or a custom-field id. */
    groupBy: z.union([z.literal("status"), ...extraGroupings.map((g) => z.literal(g)), uuid]).default("status"),
    sort: z.enum(["manual", "score"]).default("manual"),
    columns: columnsByGroupSchema.transform(keepKnownStatuses(statuses)),
    /**
     * Pinned/docked columns and column order (lib/board-layout.ts). Absent = the default layout; a layout that fails
     * validation degrades to absent via `.catch`, so it can never take the rest of the display document down. Not a URL
     * param: client state the saved-views menu reads (components/solutions/solutions-column-layout.tsx,
     * components/discovery/discovery-column-layout.tsx). Both the Solutions and the Opportunities board use it, for their
     * status grouping only; on those boards it SUPERSEDES `columns.status.order`, which is still read for views saved
     * before layouts existed. Other groupings (a custom field) ignore it.
     */
    columnLayout: boardLayoutSchema.optional().catch(undefined),
  })
}

const opportunitiesDisplaySchema = boardDisplaySchema(OPPORTUNITY_BOARD_STATUSES)
const solutionsDisplaySchema = boardDisplaySchema(SOLUTION_BOARD_STATUSES, ["squad", "opportunity"])

export type BoardViewFilters = z.infer<typeof boardFiltersSchema>
export type BoardViewDisplay = z.infer<typeof opportunitiesDisplaySchema>

type SurfaceSchemas = {
  filters: z.ZodType<unknown>
  display: z.ZodType<unknown>
  defaultFilters: unknown
  defaultDisplay: unknown
}

export const SURFACE_SCHEMAS: Readonly<Record<SavedViewSurface, SurfaceSchemas>> = {
  OPPORTUNITIES_BOARD: {
    filters: boardFiltersSchema, display: opportunitiesDisplaySchema,
    defaultFilters: boardFiltersSchema.parse({}), defaultDisplay: opportunitiesDisplaySchema.parse({}),
  },
  SOLUTIONS_BOARD: {
    filters: boardFiltersSchema, display: solutionsDisplaySchema,
    defaultFilters: boardFiltersSchema.parse({}), defaultDisplay: solutionsDisplaySchema.parse({}),
  },
  ROADMAP_WORKSPACE: {
    filters: roadmapViewFiltersSchema, display: roadmapViewDisplaySchema,
    defaultFilters: DEFAULT_ROADMAP_FILTERS, defaultDisplay: DEFAULT_ROADMAP_DISPLAY,
  },
  ROADMAP_ORG: {
    filters: roadmapViewFiltersSchema, display: roadmapViewDisplaySchema,
    defaultFilters: DEFAULT_ROADMAP_FILTERS, defaultDisplay: DEFAULT_ROADMAP_DISPLAY,
  },
}

export type SavedViewInput = {
  name: string
  visibility: (typeof ROADMAP_VIEW_VISIBILITIES)[number]
  filters: unknown
  display: unknown
}

/** Create/update payload validation for one surface. Error text matches the roadmap's: the first issue's message. */
export function savedViewInputSchemaFor(surface: SavedViewSurface): z.ZodType<SavedViewInput> {
  const { filters, display } = SURFACE_SCHEMAS[surface]
  return z.object({
    name: z.string().trim().min(1, "Name is required").max(MAX_VIEW_NAME_LENGTH),
    visibility: z.enum(ROADMAP_VIEW_VISIBILITIES).default("PERSONAL"),
    filters,
    display,
  }) as z.ZodType<SavedViewInput>
}

/** Read-side parse: never throws, falls back to the surface default on any invalid document. */
export function parseStoredFiltersFor(surface: SavedViewSurface, raw: unknown): unknown {
  const { filters, defaultFilters } = SURFACE_SCHEMAS[surface]
  const result = filters.safeParse(raw ?? {})
  return result.success ? result.data : defaultFilters
}

export function parseStoredDisplayFor(surface: SavedViewSurface, raw: unknown): unknown {
  const { display, defaultDisplay } = SURFACE_SCHEMAS[surface]
  const result = display.safeParse(raw ?? {})
  return result.success ? result.data : defaultDisplay
}
