import { z } from "zod"

/**
 * Shared recency-sort vocabulary for the `list_*` MCP tools.
 *
 * The `updatedSince` / `updatedBefore` WHERE fragment is written inline at each
 * call site, matching the pre-existing convention set by `list_tasks` and
 * `list_experiments` (and deliberately not factored out — `list_experiments`
 * ORs in `results.createdAt`, and `list_feedback` drives a keyset cursor from
 * the same window, so neither reduces to one helper).
 *
 * The sort parameter IS centralized, because every tool must honour the same
 * two invariants and they are easy to get wrong one tool at a time:
 *
 *   1. Omitting `sort` must preserve that tool's existing default ordering
 *      exactly. Each tool's default is load-bearing — `list_roadmap_items`
 *      groups by horizon, `list_docs` renders a parent/child tree, `list_tasks`
 *      orders by status then manual sortOrder — so silently reordering results
 *      would change behaviour for every existing caller. Hence
 *      `recencyOrderBy()` returns `null` rather than a default ordering.
 *   2. A recency ordering must always carry a stable `id` tiebreaker, as
 *      `list_experiments` already does. `updatedAt` is not unique, and without
 *      the tiebreaker rows with equal timestamps come back in an arbitrary
 *      order that can differ between identical calls.
 */
export const RECENCY_SORT_VALUES = ["recentlyUpdated", "leastRecentlyUpdated"] as const

export type RecencySort = (typeof RECENCY_SORT_VALUES)[number]

/** The `sort` input schema. Declare it on every list tool that supports recency ordering. */
export const recencySortSchema = z
  .enum(RECENCY_SORT_VALUES)
  .optional()
  .describe(
    "Order by last-updated time instead of this tool's default ordering: " +
      "recentlyUpdated = most recently updated first, leastRecentlyUpdated = least recently " +
      "updated first (stale-work scans). Omit to keep the default ordering.",
  )

/**
 * The `orderBy` for a recency sort, or `null` when the caller did not ask for
 * one — in which case the call site must fall back to its own default ordering.
 */
export function recencyOrderBy(
  sort: RecencySort | undefined,
): [{ updatedAt: "asc" | "desc" }, { id: "asc" }] | null {
  if (!sort) return null
  return [{ updatedAt: sort === "recentlyUpdated" ? "desc" : "asc" }, { id: "asc" }]
}
