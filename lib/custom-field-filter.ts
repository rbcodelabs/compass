import { customFieldValueMatches, isFilterableField } from "@/lib/shared-field-options"
import type { CustomFieldDefinitionData, CustomFieldObjectType } from "@/lib/types"

/**
 * Filtering a list view by a custom-field tag.
 *
 * One filter is active at a time, expressed as the search-param pair
 * `?field=<CustomFieldDefinition id>&fieldValue=<option value>`. A single pair
 * keeps the URL readable and keeps the filter menu a plain set of radio groups,
 * which is what FacetedFilterMenu already renders.
 */

export type CustomFieldFilter = { fieldId: string; value: string }

export function parseCustomFieldFilterParams(params: {
  field?: string
  fieldValue?: string
}): CustomFieldFilter | null {
  const fieldId = params.field?.trim()
  const value = params.fieldValue?.trim()
  return fieldId && value ? { fieldId, value } : null
}

export type CustomFieldFilterGroup = {
  fieldId: string
  label: string
  objectType: CustomFieldObjectType
  options: { value: string; label: string; color: string | null }[]
}

const OBJECT_TYPE_LABELS: Record<CustomFieldObjectType, string> = {
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  EXPERIMENT: "Experiment",
  OBJECTIVE: "Objective",
  KEY_RESULT: "Key Result",
  ROADMAP_ITEM: "Roadmap Item",
  TASK: "Task",
}

/**
 * The facets a page can offer: its object types' picklist fields that actually
 * have options. When a page spans two object types (Discovery renders both
 * Opportunities and their Solutions) two same-named fields would otherwise be
 * indistinguishable in the menu, so those get an object-type suffix.
 */
export function buildCustomFieldFilterGroups(
  fields: readonly CustomFieldDefinitionData[]
): CustomFieldFilterGroup[] {
  const filterable = fields.filter(isFilterableField)
  const nameCounts = new Map<string, number>()
  for (const field of filterable) {
    nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1)
  }
  return filterable.map((field) => ({
    fieldId: field.id,
    label:
      (nameCounts.get(field.name) ?? 0) > 1
        ? `${field.name} (${OBJECT_TYPE_LABELS[field.objectType]})`
        : field.name,
    objectType: field.objectType,
    options: (field.options ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      color: option.color ?? null,
    })),
  }))
}

/** The narrow slice of the Prisma client this resolver needs. */
export type CustomFieldFilterDelegate = {
  customFieldDefinition: {
    findFirst(args: unknown): Promise<{
      id: string
      objectType: string
      sharedOptionSetId: string | null
    } | null>
    findMany(args: unknown): Promise<{ id: string; objectType: string }[]>
  }
  customFieldValue: {
    findMany(args: unknown): Promise<{ objectId: string; value: unknown }[]>
  }
}

export type ResolvedCustomFieldFilter = {
  fieldId: string
  objectType: CustomFieldObjectType
  objectIds: string[]
}

/**
 * Turns a URL filter into the set of object ids a page should show.
 *
 * Returns `null` when no filter applies — the caller must then not narrow its
 * query at all. An empty `objectIds` array is different: the filter applied and
 * nothing matched, so the caller must show nothing.
 *
 * The `sharedOptionSetId` hop is what makes a shared set worth having across
 * object types: filtering Discovery by "Product Area: payments" and then
 * navigating to Tasks carries the params over, and the tag keeps working
 * because Tasks re-points the filter at its own field on the same set.
 */
export async function resolveCustomFieldFilter(
  prisma: CustomFieldFilterDelegate,
  args: {
    workspaceId: string
    objectTypes: readonly CustomFieldObjectType[]
    filter: CustomFieldFilter | null
  }
): Promise<ResolvedCustomFieldFilter | null> {
  const { workspaceId, objectTypes, filter } = args
  if (!filter) return null

  const requested = await prisma.customFieldDefinition.findFirst({
    where: { id: filter.fieldId, workspaceId },
    select: { id: true, objectType: true, sharedOptionSetId: true },
  })
  if (!requested) return null

  let resolved = objectTypes.includes(requested.objectType as CustomFieldObjectType)
    ? { id: requested.id, objectType: requested.objectType }
    : null

  if (!resolved) {
    if (!requested.sharedOptionSetId) return null
    const siblings = await prisma.customFieldDefinition.findMany({
      where: {
        workspaceId,
        sharedOptionSetId: requested.sharedOptionSetId,
        objectType: { in: [...objectTypes] },
      },
      select: { id: true, objectType: true },
      orderBy: { order: "asc" },
    })
    resolved = siblings[0] ?? null
    if (!resolved) return null
  }

  const rows = await prisma.customFieldValue.findMany({
    where: { fieldId: resolved.id },
    select: { objectId: true, value: true },
  })

  return {
    fieldId: resolved.id,
    objectType: resolved.objectType as CustomFieldObjectType,
    objectIds: rows
      .filter((row) => customFieldValueMatches(row.value, filter.value))
      .map((row) => row.objectId),
  }
}
