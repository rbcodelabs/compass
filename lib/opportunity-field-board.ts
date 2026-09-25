import type { CustomFieldDefinitionData, SelectOption } from "@/lib/types"

/**
 * Pure helpers for the Discovery board's "Group by <custom field>" mode — a
 * card-sort board whose columns are the options of an Opportunity single-select
 * field (e.g. MoSCoW: Must / Should / Could / Won't) plus an Unspecified column.
 *
 * Kept free of React and Prisma so the server page, the client board and the
 * server action all agree on exactly one definition of "groupable field",
 * "which column does this value belong to" and "is this a legal drop".
 */

/** Built-in groupings plus `field:<CustomFieldDefinition id>`. */
export type DiscoveryGroupBy = "status" | "opportunity" | `field:${string}`

const FIELD_PREFIX = "field:"

/**
 * Opportunity fields a board can be grouped by: single-select only (a
 * MULTI_SELECT value could belong to several columns at once, which a drag
 * between columns can't express) and with at least one effective option —
 * `options` is already the shared set's list when the field borrows one (see
 * lib/custom-field-definitions.ts), so an empty list means there is nothing to
 * sort into.
 */
export function groupableOpportunityFields(
  definitions: readonly CustomFieldDefinitionData[]
): CustomFieldDefinitionData[] {
  return definitions.filter(
    (definition) =>
      definition.objectType === "OPPORTUNITY" &&
      definition.fieldType === "SELECT" &&
      (definition.options?.length ?? 0) > 0
  )
}

export function fieldGroupByValue(fieldId: string): DiscoveryGroupBy {
  return `${FIELD_PREFIX}${fieldId}`
}

/** The field id encoded in a resolved `field:<id>` grouping, else null. */
export function groupByFieldId(groupBy: DiscoveryGroupBy): string | null {
  return groupBy.startsWith(FIELD_PREFIX) ? groupBy.slice(FIELD_PREFIX.length) : null
}

/**
 * Resolves the raw `?groupBy=` param. Absent/unknown values, and field ids that
 * are stale (deleted, retyped, emptied, wrong object type), fall back to the
 * default Status board rather than erroring — the same forgiving behaviour as
 * the roadmap timeline's grouping param.
 */
export function resolveDiscoveryGroupBy(
  raw: string | undefined,
  definitions: readonly CustomFieldDefinitionData[]
): DiscoveryGroupBy {
  if (raw === "opportunity") return "opportunity"
  if (!raw || !raw.startsWith(FIELD_PREFIX)) return "status"
  const fieldId = raw.slice(FIELD_PREFIX.length)
  if (!fieldId) return "status"
  return groupableOpportunityFields(definitions).some((field) => field.id === fieldId)
    ? fieldGroupByValue(fieldId)
    : "status"
}

export type FieldColumn = {
  /**
   * Stable DOM/droppable id. Option columns are prefixed so that an option
   * whose value happens to be the literal "unspecified" can never collide with
   * the Unspecified column.
   */
  id: string
  label: string
  /** The option value a card dropped here is set to; null clears the field. */
  value: string | null
  color?: string
}

export const UNSPECIFIED_COLUMN_ID = "unspecified"

/** Unspecified first, then every option in definition order. */
export function fieldColumns(options: readonly SelectOption[]): FieldColumn[] {
  return [
    { id: UNSPECIFIED_COLUMN_ID, label: "Unspecified", value: null },
    ...options.map((option) => ({
      id: `option:${option.value}`,
      label: option.label,
      value: option.value,
      ...(option.color ? { color: option.color } : {}),
    })),
  ]
}

/**
 * Normalizes a stored CustomFieldValue to the option value whose column it
 * belongs in. Absent values, non-string values and values that no longer match
 * any option (the option was renamed or removed after tagging) all map to null,
 * i.e. the Unspecified column.
 */
export function columnValueFor(stored: unknown, options: readonly SelectOption[]): string | null {
  if (typeof stored !== "string") return null
  return options.some((option) => option.value === stored) ? stored : null
}

/**
 * Server-side guard for a card-sort move. Returns an actionable error message,
 * or null when `value` may be written to `field`. `null` (clear) is always
 * allowed for an eligible field.
 */
export function validateOpportunityFieldMove(
  field: Pick<CustomFieldDefinitionData, "objectType" | "fieldType" | "options">,
  value: string | null
): string | null {
  if (field.objectType !== "OPPORTUNITY") return "This field is not an Opportunity field."
  if (field.fieldType !== "SELECT") return "Only single-select fields can be sorted on the board."
  if (value === null) return null
  if (typeof value !== "string" || !(field.options ?? []).some((option) => option.value === value)) {
    return "That option no longer exists on this field. Refresh the board and try again."
  }
  return null
}
