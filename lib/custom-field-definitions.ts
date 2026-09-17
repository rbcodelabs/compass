import { resolveEffectiveOptions, supportsSharedOptionSet } from "@/lib/shared-field-options"
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
  CustomFieldValue,
} from "@/lib/types"

/**
 * The single read boundary for custom field definitions.
 *
 * Every surface that renders a picklist — detail panels, settings, filter menus
 * — goes through here so that "which list of options does this field actually
 * offer?" is answered in exactly one place, whether the field owns its options
 * or borrows a SharedFieldOptionSet.
 */

export type CustomFieldDefinitionRow = {
  id: string
  name: string
  fieldType: string
  objectType: string
  options: unknown
  sharedOptionSetId: string | null
  required: boolean
  order: number
  sharedOptionSet?: { id: string; name: string; options: unknown } | null
}

export function toCustomFieldDefinitionData(
  row: CustomFieldDefinitionRow
): CustomFieldDefinitionData {
  return {
    id: row.id,
    name: row.name,
    fieldType: row.fieldType as CustomFieldType,
    objectType: row.objectType as CustomFieldObjectType,
    // Non-picklist fields have no options at all; keep that as null rather than
    // an empty array so existing `field.options ?? []` call sites are unchanged.
    options: supportsSharedOptionSet(row.fieldType) ? resolveEffectiveOptions(row) : null,
    sharedOptionSetId: row.sharedOptionSetId ?? null,
    sharedOptionSetName: row.sharedOptionSet?.name ?? null,
    required: row.required,
    order: row.order,
  }
}

type DefinitionDelegate = {
  customFieldDefinition: { findMany(args: unknown): Promise<CustomFieldDefinitionRow[]> }
}

export async function loadCustomFieldDefinitions(
  prisma: DefinitionDelegate,
  args: { workspaceId: string; objectTypes?: readonly CustomFieldObjectType[] }
): Promise<CustomFieldDefinitionData[]> {
  const rows = await prisma.customFieldDefinition.findMany({
    where: {
      workspaceId: args.workspaceId,
      ...(args.objectTypes ? { objectType: { in: [...args.objectTypes] } } : {}),
    },
    orderBy: [{ objectType: "asc" }, { order: "asc" }],
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  return rows.map(toCustomFieldDefinitionData)
}

/** A field definition paired with what this particular object is tagged with. */
export type CustomFieldWithValue = CustomFieldDefinitionData & {
  currentValue: CustomFieldValue
}

type ValueDelegate = DefinitionDelegate & {
  customFieldValue: {
    findMany(args: unknown): Promise<{ fieldId: string; value: unknown }[]>
  }
}

/**
 * One object's editable custom fields: every definition its type carries in the
 * workspace, each paired with this object's stored value (or null).
 *
 * This is what a detail surface needs to render `CustomFieldsPanel`, and it is
 * shared rather than re-derived per entity so that "what can this object be
 * tagged with, and what is it tagged with now?" is answered the same way for
 * Tasks, RoadmapItems and Solutions alike. Definitions are returned even when
 * the object has no value for them — an untagged field must still be offered,
 * or the object can never be tagged in the first place.
 */
export async function loadCustomFieldsForObject(
  prisma: ValueDelegate,
  args: { workspaceId: string; objectType: CustomFieldObjectType; objectId: string }
): Promise<CustomFieldWithValue[]> {
  const rows = await prisma.customFieldDefinition.findMany({
    where: { workspaceId: args.workspaceId, objectType: args.objectType },
    orderBy: { order: "asc" },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  if (rows.length === 0) return []

  const values = await prisma.customFieldValue.findMany({
    where: { fieldId: { in: rows.map((row) => row.id) }, objectId: args.objectId },
  })
  const valueByFieldId = new Map(values.map((v) => [v.fieldId, v.value as CustomFieldValue]))

  return rows.map((row) => ({
    ...toCustomFieldDefinitionData(row),
    currentValue: valueByFieldId.get(row.id) ?? null,
  }))
}
