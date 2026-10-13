/**
 * Free-text quick filter for the card sort board (kanban and table views).
 *
 * Purely a view concern: it hides cards on screen and never touches proposals,
 * official values, or a column's officialCount. A column header keeps reporting
 * how many objects officially hold that value whether or not they are visible —
 * the filter narrows what you are looking at, not what is true.
 *
 * Matching is case-insensitive and whitespace-tokenised; every term must appear
 * somewhere in the card's searchable text (title, description, squad name), in
 * any order. "export slow" matches "Slow CSV exports".
 */

import type { KanbanColumn } from "@/lib/card-sort-kanban"
import type { CardSortCardMeta } from "@/lib/card-sort-cards"

export function quickFilterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** True when every term of `query` appears in at least one of `fields`. */
export function matchesQuickFilter(
  fields: ReadonlyArray<string | null | undefined>,
  query: string
): boolean {
  const terms = quickFilterTerms(query)
  if (terms.length === 0) return true
  const haystack = fields.filter(Boolean).join("\n").toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** The searchable text for one sortable object. */
export function cardSearchFields(
  title: string,
  meta: CardSortCardMeta | undefined
): Array<string | null | undefined> {
  return [title, meta?.description, meta?.squad?.name]
}

/**
 * Narrow each column's rendered contents to objects that match. The same object
 * id decides its solid card, its ghost and its incoming markers together, so a
 * filtered-in card never loses the ghost that explains where it came from.
 * officialCount is deliberately left as built.
 */
export function filterKanbanColumns(
  columns: KanbanColumn[],
  isVisible: (objectId: string) => boolean
): KanbanColumn[] {
  return columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => isVisible(card.objectId)),
    vacated: column.vacated.filter((slot) => isVisible(slot.objectId)),
    incoming: column.incoming.filter((marker) => isVisible(marker.objectId)),
  }))
}
