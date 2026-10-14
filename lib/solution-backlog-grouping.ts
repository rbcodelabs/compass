import { fieldColumns } from "@/lib/opportunity-field-board"
import { orderCards, sortByScoreDesc, type OrderableCard } from "@/lib/discovery-board-ordering"
import { SOLUTION_STATUS_ORDER } from "@/lib/solution-status"
import type { CustomFieldDefinitionData, SelectOption, SolutionStatus } from "@/lib/types"

/**
 * Pure helpers for the Solutions backlog's "Group by" modes and its table
 * ordering. Free of React and Prisma so the server page and the client board
 * agree on a single definition of "groupable field", "which column does this
 * card belong to" and "how is the table ordered".
 *
 * Status (the default) keeps its own persisted-order board (lib/solution-backlog.ts).
 * Every other grouping is a read-only view: a column mixes Solutions from many
 * Opportunities, and none of these groupings has a Solution-level write path
 * (squad and parent belong to the Opportunity; there is no Solution field-value
 * action), so cards are never draggable between them.
 */

/** Status (default), Squad, parent Opportunity, or `field:<CustomFieldDefinition id>`. */
export type SolutionGroupBy = "status" | "squad" | "opportunity" | `field:${string}`

const FIELD_PREFIX = "field:"

export type SolutionGroupCard = OrderableCard & {
  status: SolutionStatus
  opportunity: {
    id: string
    title: string
    squad: { id: string; name: string; color: string } | null
  }
  /** Normalized option value of the active group field; null/absent = Unspecified. */
  fieldValue?: string | null
}

/**
 * Solution fields a board can be grouped by: single-select only (a
 * MULTI_SELECT value could belong to several columns at once) with at least
 * one effective option.
 */
export function groupableSolutionFields(
  definitions: readonly CustomFieldDefinitionData[]
): CustomFieldDefinitionData[] {
  return definitions.filter(
    (definition) =>
      definition.objectType === "SOLUTION" &&
      definition.fieldType === "SELECT" &&
      (definition.options?.length ?? 0) > 0
  )
}

export function solutionFieldGroupByValue(fieldId: string): SolutionGroupBy {
  return `${FIELD_PREFIX}${fieldId}`
}

/** The field id encoded in a resolved `field:<id>` grouping, else null. */
export function solutionGroupByFieldId(groupBy: SolutionGroupBy): string | null {
  return groupBy.startsWith(FIELD_PREFIX) ? groupBy.slice(FIELD_PREFIX.length) : null
}

/**
 * Resolves the raw `?groupBy=` param. Absent or unknown values, and field ids
 * that are stale (deleted, retyped, emptied, an Opportunity field), fall back
 * to Status rather than erroring.
 */
export function resolveSolutionGroupBy(
  raw: string | undefined,
  definitions: readonly CustomFieldDefinitionData[]
): SolutionGroupBy {
  if (raw === "squad" || raw === "opportunity") return raw
  if (!raw || !raw.startsWith(FIELD_PREFIX)) return "status"
  const fieldId = raw.slice(FIELD_PREFIX.length)
  if (!fieldId) return "status"
  return groupableSolutionFields(definitions).some((field) => field.id === fieldId)
    ? solutionFieldGroupByValue(fieldId)
    : "status"
}

export type SolutionGroupColumn<T> = {
  /** Stable, DOM-safe id; prefixed per grouping so ids never collide. */
  id: string
  label: string
  color?: string
  items: T[]
}

export const NO_SQUAD_GROUP_ID = "squad:none"
export const UNSPECIFIED_GROUP_ID = "field:unspecified"

type GroupContext = {
  squads: readonly { id: string; name: string; color: string }[]
  field?: { options: SelectOption[] } | null
}

/**
 * Buckets cards into the columns of a non-status grouping.
 *  - squad: every workspace squad (workspace order) plus "No squad";
 *  - opportunity: one column per parent Opportunity that has a visible
 *    Solution, in first-appearance order (an Opportunity with none has no card
 *    to show);
 *  - field: Unspecified, then one column per option in definition order.
 * `status` is not handled here (use buildSolutionBacklogColumns); it returns [].
 */
export function buildSolutionGroups<T extends SolutionGroupCard>(
  cards: readonly T[],
  groupBy: SolutionGroupBy,
  context: GroupContext,
  sortByScore: boolean
): SolutionGroupColumn<T>[] {
  if (groupBy === "squad") {
    const columns: SolutionGroupColumn<T>[] = [
      ...context.squads.map((squad) => ({
        id: `squad:${squad.id}`,
        label: squad.name,
        color: squad.color,
        items: cards.filter((card) => card.opportunity.squad?.id === squad.id),
      })),
      {
        id: NO_SQUAD_GROUP_ID,
        label: "No squad",
        // A card whose squad is not in the list (deleted) reads as unassigned.
        items: cards.filter(
          (card) => !card.opportunity.squad || !context.squads.some((s) => s.id === card.opportunity.squad?.id)
        ),
      },
    ]
    return columns.map((column) => ({ ...column, items: orderCards(column.items, sortByScore) }))
  }

  if (groupBy === "opportunity") {
    const byOpportunity = new Map<string, SolutionGroupColumn<T>>()
    for (const card of cards) {
      let column = byOpportunity.get(card.opportunity.id)
      if (!column) {
        column = {
          id: `opportunity:${card.opportunity.id}`,
          label: card.opportunity.title,
          ...(card.opportunity.squad ? { color: card.opportunity.squad.color } : {}),
          items: [],
        }
        byOpportunity.set(card.opportunity.id, column)
      }
      column.items.push(card)
    }
    return [...byOpportunity.values()].map((column) => ({ ...column, items: orderCards(column.items, sortByScore) }))
  }

  const fieldId = solutionGroupByFieldId(groupBy)
  if (fieldId && context.field) {
    return fieldColumns(context.field.options).map((column) => ({
      id: column.value === null ? UNSPECIFIED_GROUP_ID : `field:${column.id}`,
      label: column.label,
      ...(column.color ? { color: column.color } : {}),
      items: orderCards(
        cards.filter((card) => (card.fieldValue ?? null) === column.value),
        sortByScore
      ),
    }))
  }

  return []
}

/**
 * Table ordering. Score view: highest first, unscored last. Otherwise the
 * lifecycle order (Idea to Killed) then the persisted `sortOrder`, matching how
 * the Discovery table lists its rows. Stable: ties keep input order.
 */
export function orderSolutionsForTable<T extends SolutionGroupCard>(cards: readonly T[], sortByScore: boolean): T[] {
  if (sortByScore) return sortByScoreDesc([...cards])
  const rank = (status: SolutionStatus) => SOLUTION_STATUS_ORDER.indexOf(status)
  return [...cards].sort((a, b) => rank(a.status) - rank(b.status) || a.sortOrder - b.sortOrder)
}
