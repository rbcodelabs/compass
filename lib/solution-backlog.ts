import { orderCards, type OrderableCard } from "@/lib/discovery-board-ordering"
import { SOLUTION_STATUS_ORDER } from "@/lib/solution-status"
import type { SolutionStatus } from "@/lib/types"

/**
 * Pure helpers for the Solutions backlog: a flat board of every Solution in a
 * workspace, one column per SolutionStatus, so Solutions from different
 * Opportunities can be compared side by side.
 *
 * Kept free of React and Prisma so the server page and the client board agree
 * on one definition of column membership, ordering and what a drop persists.
 */

export type SolutionBacklogCard = OrderableCard & {
  status: SolutionStatus
  opportunity: { id: string; title: string }
}

export type SolutionBacklogColumns<T> = Record<SolutionStatus, T[]>

/**
 * Buckets cards into one column per status. Manual order is the persisted
 * `sortOrder`; score order is a read-only view (see orderCards).
 */
export function buildSolutionBacklogColumns<T extends SolutionBacklogCard>(
  cards: readonly T[],
  sortByScore: boolean
): SolutionBacklogColumns<T> {
  const columns = {} as SolutionBacklogColumns<T>
  for (const status of SOLUTION_STATUS_ORDER) {
    columns[status] = orderCards(
      cards.filter((card) => card.status === status),
      sortByScore
    )
  }
  return columns
}

/**
 * Identity of the rendered dataset, for use as the board's React `key`. The
 * board seeds its columns from `useState` so drags are optimistic, so the id
 * set (not the filter inputs) decides when to remount: a filter change or an
 * unrelated create arriving by revalidation changes it, a status move does not.
 */
export function solutionBacklogKey(cards: ReadonlyArray<{ id: string }>): string {
  return cards.map((card) => card.id).join(",")
}

export const SOLUTION_BACKLOG_COLUMN_PREFIX = "column-"

export function solutionBacklogColumnId(status: SolutionStatus): string {
  return `${SOLUTION_BACKLOG_COLUMN_PREFIX}${status}`
}

/** The status encoded in a droppable column id; null for a card id or junk. */
export function parseSolutionBacklogColumnId(id: string): SolutionStatus | null {
  if (!id.startsWith(SOLUTION_BACKLOG_COLUMN_PREFIX)) return null
  const status = id.slice(SOLUTION_BACKLOG_COLUMN_PREFIX.length)
  return SOLUTION_STATUS_ORDER.includes(status as SolutionStatus) ? (status as SolutionStatus) : null
}

/**
 * What a drop persists. Only a cross-column move writes: a column mixes
 * Solutions from many Opportunities, but `sortOrder` is scoped to one
 * Opportunity and status, so a within-column drop index has no meaning and
 * would corrupt the per-opportunity order the Opportunity panel relies on.
 */
export type SolutionDropPlan = { kind: "none" } | { kind: "move"; status: SolutionStatus }

export function planSolutionDrop(
  sourceStatus: SolutionStatus | null,
  destStatus: SolutionStatus | null
): SolutionDropPlan {
  if (!sourceStatus || !destStatus || sourceStatus === destStatus) return { kind: "none" }
  return { kind: "move", status: destStatus }
}

/**
 * Where the retired `/discovery?groupBy=opportunity` swimlane view now lives.
 * Squad and custom-field filters carry over; everything else is dropped.
 */
export function legacySwimlaneRedirectPath(
  orgSlug: string,
  workspaceSlug: string,
  params: { squad?: string; field?: string; fieldValue?: string }
): string {
  const query = new URLSearchParams()
  if (params.squad) query.set("squad", params.squad)
  if (params.field) query.set("field", params.field)
  if (params.fieldValue) query.set("fieldValue", params.fieldValue)
  const qs = query.toString()
  return `/${orgSlug}/${workspaceSlug}/solutions${qs ? `?${qs}` : ""}`
}
