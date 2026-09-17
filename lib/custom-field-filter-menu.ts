import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter"
import type { FacetedFilterGroup } from "@/components/patterns/faceted-filter-menu"

/**
 * Client-side glue between a page's filterable custom fields and the generic
 * FacetedFilterMenu. Kept out of the individual filter components so Discovery,
 * Roadmap and Tasks cannot drift apart on how a tag filter reads or writes.
 */

export const CUSTOM_FIELD_FILTER_PARAMS = ["field", "fieldValue"] as const

/**
 * One custom-field filter is live at a time. Writing the pair atomically here
 * is what enforces that: picking a value in a second field group replaces the
 * first rather than adding to it.
 */
export function applyCustomFieldFilterParams(
  params: URLSearchParams,
  fieldId: string,
  value: string | null
) {
  if (value) {
    params.set("field", fieldId)
    params.set("fieldValue", value)
  } else {
    for (const name of CUSTOM_FIELD_FILTER_PARAMS) params.delete(name)
  }
}

export function customFieldFacetedGroups(args: {
  groups: readonly CustomFieldFilterGroup[]
  activeFieldId: string | null
  activeValue?: string | null
  onChange: (fieldId: string, value: string | null) => void
}): FacetedFilterGroup[] {
  const { groups, activeFieldId, activeValue, onChange } = args
  return groups.map((group) => ({
    id: `custom-field:${group.fieldId}`,
    label: group.label,
    value: group.fieldId === activeFieldId ? (activeValue ?? null) : null,
    onValueChange: (value: string | null) => onChange(group.fieldId, value),
    options: group.options,
  }))
}
