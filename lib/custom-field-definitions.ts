import { resolveEffectiveOptions, supportsSharedOptionSet } from "@/lib/shared-field-options"
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
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
