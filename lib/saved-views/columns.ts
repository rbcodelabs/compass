/**
 * Board column layout for saved views: the stored shape and the one pure resolver
 * that turns (saved layout, live card counts) into the columns a board renders.
 * No database, no React, so the server page, the URL parser and the client menu
 * can all share it.
 *
 * Product rules enforced here, and only here:
 *   1. With no saved layout the order is the surface's default order.
 *   2. A saved order that omits a column appends the missing ones, in default order.
 *   3. A hidden column that still has cards is shown anyway ("forced visible").
 */
import { z } from "zod"
import type { OpportunityStatus } from "@/lib/types"

/** Upper bound on either list; bounds the stored document and any URL built from it. */
export const MAX_COLUMN_KEYS = 50

/** Default Opportunities board order when no view is selected. Single source of truth for the board. */
export const DEFAULT_OPPORTUNITY_COLUMN_ORDER = [
  "ACTIVE",
  "PRIORITIZED",
  "VALIDATING",
  "EXPLORING",
] as const satisfies readonly OpportunityStatus[]

const columnKeyList = z.array(z.string().min(1).max(100)).max(MAX_COLUMN_KEYS)

/** One grouping's layout: which columns, in which order, are hidden. */
export const columnLayoutSchema = z.object({
  order: columnKeyList.default([]),
  hidden: columnKeyList.default([]),
})

export type ColumnLayout = z.infer<typeof columnLayoutSchema>

/**
 * `display.columns`: a layout per grouping key (`"status"` or a custom-field id), so
 * switching the grouping back and forth never loses the other grouping's order.
 */
export const columnsByGroupSchema = z.record(z.string().min(1).max(100), columnLayoutSchema).default({})

export type ColumnsByGroup = z.infer<typeof columnsByGroupSchema>

export type ResolvedColumns = {
  /** Every known column in render order, including hidden ones (for the Columns control). */
  order: string[]
  /** Columns to render, in render order. */
  visible: string[]
  /** Columns the layout hides that are shown anyway because they hold cards. */
  forcedVisible: string[]
}

function dedupe(keys: readonly string[]): string[] {
  return [...new Set(keys)]
}

/**
 * @param layout       the saved or URL layout for the active grouping, if any
 * @param allKeys      every column that exists for this grouping; anything else in the layout is stale and dropped
 * @param defaultOrder preferred order for columns the layout does not place (may omit keys; those follow, in `allKeys` order)
 * @param countsByKey  live card count per column; computed per render, never stored
 */
export function resolveColumns(
  layout: Partial<ColumnLayout> | undefined,
  allKeys: readonly string[],
  defaultOrder: readonly string[],
  countsByKey: Readonly<Record<string, number>>,
): ResolvedColumns {
  const known = new Set(allKeys)
  const defaults = dedupe([...defaultOrder.filter((key) => known.has(key)), ...allKeys])
  const saved = dedupe(layout?.order ?? []).filter((key) => known.has(key))
  const savedSet = new Set(saved)
  const order = [...saved, ...defaults.filter((key) => !savedSet.has(key))]

  const hidden = new Set((layout?.hidden ?? []).filter((key) => known.has(key)))
  const forcedVisible = order.filter((key) => hidden.has(key) && (countsByKey[key] ?? 0) > 0)
  const visible = order.filter((key) => !hidden.has(key) || forcedVisible.includes(key))

  return { order, visible, forcedVisible }
}
