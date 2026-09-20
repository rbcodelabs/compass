/**
 * Batch-loading custom field values for a *set* of objects.
 *
 * Everything else that reads `CustomFieldValue` reads for one object
 * (`loadCustomFieldsForObject` in lib/custom-field-definitions.ts) or for one
 * field across every object (`resolveCustomFieldFilter` in
 * lib/custom-field-filter.ts). Custom-field roadmap-timeline grouping needs a
 * third shape — one field, many specific objects — so this is the first
 * batch-by-object-id loader in the app.
 */

export type CustomFieldValuesBatchDelegate = {
  customFieldValue: {
    findMany(args: unknown): Promise<{ objectId: string; value: unknown }[]>
  }
}

/**
 * Loads one field's stored value for each of the given object ids, as a map
 * keyed by objectId. Objects with no stored value for the field are simply
 * absent from the map (never a `null` entry), so `map.has(id)` and
 * `map.get(id)` agree.
 */
export async function loadCustomFieldValuesForObjects(
  prisma: CustomFieldValuesBatchDelegate,
  args: { fieldId: string; objectIds: readonly string[] }
): Promise<Map<string, unknown>> {
  if (args.objectIds.length === 0) return new Map()

  const rows = await prisma.customFieldValue.findMany({
    where: { fieldId: args.fieldId, objectId: { in: [...args.objectIds] } },
    select: { objectId: true, value: true },
  })

  return new Map(rows.map((row) => [row.objectId, row.value]))
}
