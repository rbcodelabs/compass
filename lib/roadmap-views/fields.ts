/**
 * Cross-workspace custom fields for the roadmap. Pure (no database, no React).
 *
 * A field is identified across workspaces by its key (type + case-insensitive name,
 * see `makeRoadmapFieldKey`). This module turns the per-workspace definitions the
 * viewer can read into one facet per key, and turns stored values into the labels
 * a card / table cell / group heading shows. Picklist values are matched by option
 * LABEL, not option value, because two workspaces' "Status" fields can store
 * different option values for the same label.
 */
import { toStoredOptionValues } from "@/lib/shared-field-options"
import { makeRoadmapFieldKey, ROADMAP_PICKLIST_FIELD_TYPES, type RoadmapFieldType } from "@/lib/roadmap-views/schema"

/** One workspace's definition of a field, with its effective (shared-set aware) options already resolved. */
export type FieldDefinitionInput = {
  id: string
  workspaceId: string
  name: string
  fieldType: string
  order: number
  options: ReadonlyArray<{ label: string; value: string; color?: string }>
}

export type FieldOptionFacet = { label: string; color?: string }

export type RoadmapFieldFacet = {
  key: string
  /** Display name, taken from the first definition found. */
  name: string
  fieldType: RoadmapFieldType
  /** Union of option labels across definitions, in first-seen order. Empty for non-picklists. */
  options: FieldOptionFacet[]
  definitionIds: string[]
}

export type FieldCellValue = { label: string; color?: string }

export function isPicklistType(fieldType: string): boolean {
  return (ROADMAP_PICKLIST_FIELD_TYPES as readonly string[]).includes(fieldType)
}

export function buildFieldFacets(definitions: readonly FieldDefinitionInput[]): RoadmapFieldFacet[] {
  const byKey = new Map<string, RoadmapFieldFacet>()
  // Lowest `order` first so the facet's display name and option order come from the most prominent definition.
  const sorted = [...definitions].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  for (const def of sorted) {
    const key = makeRoadmapFieldKey(def.fieldType, def.name)
    let facet = byKey.get(key)
    if (!facet) {
      facet = { key, name: def.name.trim(), fieldType: def.fieldType as RoadmapFieldType, options: [], definitionIds: [] }
      byKey.set(key, facet)
    }
    facet.definitionIds.push(def.id)
    for (const option of def.options) {
      const existing = facet.options.find((o) => o.label.toLowerCase() === option.label.toLowerCase())
      if (!existing) facet.options.push(option.color ? { label: option.label, color: option.color } : { label: option.label })
      else if (!existing.color && option.color) existing.color = option.color
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Stored value -> cells to display. Picklists map option values to labels; unknown stored values show raw. */
export function toCellValues(def: FieldDefinitionInput, stored: unknown): FieldCellValue[] {
  if (stored === null || stored === undefined) return []
  if (isPicklistType(def.fieldType)) {
    const byValue = new Map(def.options.map((o) => [o.value, o]))
    return toStoredOptionValues(stored).map((value) => {
      const option = byValue.get(value)
      return option?.color ? { label: option.label, color: option.color } : { label: option?.label ?? value }
    })
  }
  if (def.fieldType === "BOOLEAN") return typeof stored === "boolean" ? [{ label: stored ? "Yes" : "No" }] : []
  if (typeof stored === "string") return stored.trim() ? [{ label: stored }] : []
  if (typeof stored === "number") return [{ label: String(stored) }]
  return []
}

/** Does any cell carry one of the wanted labels (case-insensitive)? */
export function cellsMatchLabels(cells: readonly FieldCellValue[], wanted: readonly string[]): boolean {
  const labels = new Set(wanted.map((w) => w.toLowerCase()))
  return cells.some((c) => labels.has(c.label.toLowerCase()))
}
