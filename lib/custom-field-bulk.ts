/**
 * Agent-scale custom field operations for the MCP tools (TASK-95 / RM-8):
 * filtering by field value, reading values for many objects at once, writing
 * one value to many objects, and a grouped-by-field read.
 *
 * Every query here is workspace-scoped through the field DEFINITIONS: a field
 * id is first resolved against `workspaceId` + object type, and value rows are
 * only ever read for those verified field ids, so a foreign field id or a
 * foreign object id can never surface another workspace's data.
 */

import { z } from "zod"
import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { getMcpActor, resolveEntityWorkspaceId } from "@/lib/mcp-authz"
import { BATCH_MAX_ITEMS } from "@/lib/batch-create-limits"
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions"
import { CUSTOM_FIELD_ENTITY, prepareFieldWrite } from "@/lib/custom-field-tool-handlers"
import type { CustomFieldDefinitionData, CustomFieldObjectType, CustomFieldType, CustomFieldValue } from "@/lib/types"

type Prisma = ReturnType<typeof getPrisma>

// ── Filters ──────────────────────────────────────────────────────────────────

export type CustomFieldFilter = {
  fieldId: string
  value?: string | number | boolean
  anyOf?: string[]
  isSet?: boolean
}

export const customFieldFilterSchema = z
  .object({
    fieldId: z.string().uuid().describe("UUID of the custom field definition (from list_custom_field_definitions)"),
    value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("Match this value"),
    anyOf: z.array(z.string()).min(1).max(50).optional().describe("Match any of these values (OR within one filter)"),
    isSet: z.boolean().optional().describe("true = the field has a value; false = the field is unset"),
  })
  .strict()
  .refine(
    (f) => [f.value, f.anyOf, f.isSet].filter((x) => x !== undefined).length === 1,
    { message: "Provide exactly one of value, anyOf, or isSet." },
  )

function isUnset(stored: unknown): boolean {
  return stored === null || stored === undefined || stored === "" || (Array.isArray(stored) && stored.length === 0)
}

/**
 * Whether one stored value satisfies a filter, by field type:
 *  - SELECT: exact option value (case-sensitive) equal to `value`, or to any of `anyOf`
 *  - MULTI_SELECT: the stored array contains `value`, or any of `anyOf`
 *  - TEXT / URL: case-insensitive substring match
 *  - NUMBER / BOOLEAN / DATE: exact equality (`anyOf` supports strings only, so DATE only)
 *  - isSet: presence, for every type
 */
export function matchesCustomFieldFilter(fieldType: CustomFieldType, filter: CustomFieldFilter, stored: unknown): boolean {
  if (filter.isSet !== undefined) return filter.isSet ? !isUnset(stored) : isUnset(stored)
  if (isUnset(stored)) return false
  const candidates: Array<string | number | boolean> = filter.anyOf ?? (filter.value !== undefined ? [filter.value] : [])
  switch (fieldType) {
    case "MULTI_SELECT":
      return Array.isArray(stored) && candidates.some((c) => stored.includes(c))
    case "TEXT":
    case "URL":
      return typeof stored === "string" && candidates.some((c) => stored.toLowerCase().includes(String(c).toLowerCase()))
    default:
      return candidates.some((c) => c === stored)
  }
}

type IdCondition = { id: { in: string[] } } | { id: { notIn: string[] } }

/**
 * Turns filters (ANDed) into `id` conditions for the object's own table.
 * Fields are resolved against the workspace and object type first, so a field
 * from another workspace or object type is rejected rather than silently
 * matching nothing.
 */
export async function buildCustomFieldFilterConditions(
  prisma: Prisma,
  { workspaceId, objectType, filters }: { workspaceId: string; objectType: CustomFieldObjectType; filters: CustomFieldFilter[] },
): Promise<{ ok: true; conditions: IdCondition[] } | { ok: false; error: string }> {
  const definitions = await loadCustomFieldDefinitions(prisma, { workspaceId, objectTypes: [objectType] })
  const byId = new Map(definitions.map((d) => [d.id, d]))
  for (const filter of filters) {
    const definition = byId.get(filter.fieldId)
    if (!definition) {
      return { ok: false, error: `Custom field "${filter.fieldId}" is not a ${objectType} custom field in this workspace. Use list_custom_field_definitions with objectType ${objectType}.` }
    }
    if (definition.fieldType === "SELECT" || definition.fieldType === "MULTI_SELECT") {
      const allowed = (definition.options ?? []).map((o) => o.value)
      const requested = filter.anyOf ?? (typeof filter.value === "string" ? [filter.value] : [])
      const unknown = requested.filter((v) => !allowed.includes(v))
      if (unknown.length > 0) {
        return { ok: false, error: `${JSON.stringify(unknown)} ${unknown.length === 1 ? "is" : "are"} not among "${definition.name}" options: ${allowed.join(", ") || "(none defined)"}.` }
      }
    }
  }

  const conditions: IdCondition[] = []
  for (const filter of filters) {
    const definition = byId.get(filter.fieldId)!
    const rows = await prisma.customFieldValue.findMany({
      where: { fieldId: filter.fieldId },
      select: { objectId: true, value: true },
    })
    if (filter.isSet === false) {
      conditions.push({ id: { notIn: rows.filter((r) => !isUnset(r.value)).map((r) => r.objectId) } })
    } else {
      conditions.push({ id: { in: rows.filter((r) => matchesCustomFieldFilter(definition.fieldType, filter, r.value)).map((r) => r.objectId) } })
    }
  }
  return { ok: true, conditions }
}

// ── Reading values for many objects ──────────────────────────────────────────

export type CustomFieldColumn = { id: string; name: string; fieldType: CustomFieldType; key: string }

/** Picks the columns to show; `fieldIds` omitted means every definition for the object type. */
export async function resolveCustomFieldColumns(
  prisma: Prisma,
  { workspaceId, objectType, fieldIds }: { workspaceId: string; objectType: CustomFieldObjectType; fieldIds?: string[] },
): Promise<{ ok: true; columns: CustomFieldColumn[] } | { ok: false; error: string }> {
  const definitions = await loadCustomFieldDefinitions(prisma, { workspaceId, objectTypes: [objectType] })
  let chosen: CustomFieldDefinitionData[] = definitions
  if (fieldIds && fieldIds.length > 0) {
    const byId = new Map(definitions.map((d) => [d.id, d]))
    const missing = fieldIds.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      return { ok: false, error: `Custom field ${missing.map((id) => `"${id}"`).join(", ")} is not a ${objectType} custom field in this workspace. Use list_custom_field_definitions with objectType ${objectType}.` }
    }
    chosen = [...new Set(fieldIds)].map((id) => byId.get(id)!)
  }
  // Keyed by name for readability; a duplicate name falls back to name + short id so no value is overwritten.
  const seen = new Map<string, number>()
  for (const d of chosen) seen.set(d.name, (seen.get(d.name) ?? 0) + 1)
  return {
    ok: true,
    columns: chosen.map((d) => ({
      id: d.id,
      name: d.name,
      fieldType: d.fieldType,
      key: (seen.get(d.name) ?? 0) > 1 ? `${d.name} (${d.id.slice(0, 8)})` : d.name,
    })),
  }
}

/** objectId -> { columnKey -> value | null }, for exactly the given objects and columns. */
export async function loadCustomFieldValuesFor(
  prisma: Prisma,
  columns: CustomFieldColumn[],
  objectIds: string[],
): Promise<Map<string, Record<string, CustomFieldValue>>> {
  const result = new Map<string, Record<string, CustomFieldValue>>()
  const blank = () => Object.fromEntries(columns.map((c) => [c.key, null])) as Record<string, CustomFieldValue>
  for (const id of objectIds) result.set(id, blank())
  if (columns.length === 0 || objectIds.length === 0) return result

  const keyByField = new Map(columns.map((c) => [c.id, c.key]))
  const rows = await prisma.customFieldValue.findMany({
    where: { fieldId: { in: columns.map((c) => c.id) }, objectId: { in: objectIds } },
    select: { objectId: true, fieldId: true, value: true },
  })
  for (const row of rows) {
    const key = keyByField.get(row.fieldId)
    const target = result.get(row.objectId)
    if (key && target) target[key] = isUnset(row.value) ? null : (row.value as CustomFieldValue)
  }
  return result
}

export function formatFieldValue(value: CustomFieldValue): string {
  return Array.isArray(value) ? value.join(",") : String(value)
}

/** "Field: value; Field: value", skipping unset fields so compact listings stay short. */
export function formatFieldValues(values: Record<string, CustomFieldValue> | undefined): string {
  return Object.entries(values ?? {})
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${formatFieldValue(v)}`)
    .join("; ")
}

export const describeColumns = (columns: CustomFieldColumn[]) => columns.map((c) => ({ id: c.id, name: c.name, fieldType: c.fieldType }))

// ── set_custom_field_values (bulk) ───────────────────────────────────────────

export type BulkSetResult = { objectId: string; ok: true } | { objectId: string; ok: false; code: "NOT_FOUND" | "WRITE_FAILED"; error: string }

export async function setCustomFieldValues({
  workspaceId,
  objectType,
  fieldId,
  objectIds,
  value,
}: {
  workspaceId: string
  objectType: CustomFieldObjectType
  fieldId: string
  objectIds: string[]
  value: CustomFieldValue
}) {
  const ids = [...new Set(objectIds)]
  if (ids.length === 0) return fail("Provide at least one objectId.")
  const actor = getMcpActor()
  const agent = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"
  const cap = BATCH_MAX_ITEMS[agent ? "agent" : "human"]
  if (ids.length > cap) return fail(`Update at most ${cap} objects per request. Nothing was updated.`)

  const prisma = getPrisma()
  // The field is validated once, against the declared workspace; the same check the single-object tool applies.
  const prepared = await prepareFieldWrite(prisma, { workspaceId, objectType, fieldId, value, subject: `workspace "${workspaceId}"` })
  if (!prepared.ok) return fail(prepared.error)
  const { field, clearing } = prepared

  const entityType = CUSTOM_FIELD_ENTITY[objectType]
  const results: BulkSetResult[] = []
  const found: string[] = []
  for (const objectId of ids) {
    // Missing and other-workspace objects are indistinguishable: both are NOT_FOUND, so nothing leaks.
    const owner = await resolveEntityWorkspaceId(entityType, objectId)
    if (owner !== workspaceId) {
      results.push({ objectId, ok: false, code: "NOT_FOUND", error: `${objectType} "${objectId}" not found in this workspace.` })
    } else {
      found.push(objectId)
    }
  }

  const written = new Set<string>()
  if (clearing) {
    if (found.length > 0) {
      try {
        await prisma.customFieldValue.deleteMany({ where: { fieldId, objectId: { in: found } } })
        for (const id of found) written.add(id)
      } catch {
        for (const id of found) results.push({ objectId: id, ok: false, code: "WRITE_FAILED", error: "Could not clear the value." })
      }
    }
  } else {
    for (const objectId of found) {
      try {
        await prisma.customFieldValue.upsert({
          where: { fieldId_objectId: { fieldId, objectId } },
          create: { fieldId, objectId, value: value as object },
          update: { value: value as object, updatedAt: new Date() },
        })
        written.add(objectId)
      } catch {
        results.push({ objectId, ok: false, code: "WRITE_FAILED", error: "Could not save the value." })
      }
    }
  }
  for (const id of written) results.push({ objectId: id, ok: true })

  // Report in the caller's order.
  const order = new Map(ids.map((id, i) => [id, i]))
  results.sort((a, b) => (order.get(a.objectId) ?? 0) - (order.get(b.objectId) ?? 0))
  const updated = results.filter((r) => r.ok).length
  const failed = results.length - updated
  const verb = clearing ? "Cleared" : "Set"
  const lines = results.map((r, i) => (r.ok ? `${i + 1}. ok: ${r.objectId}` : `${i + 1}. ${r.code}: ${r.error}`))
  return ok(
    `**${verb} "${field.name}" on ${updated} ${objectType} object${updated === 1 ? "" : "s"}**${clearing ? "" : ` to ${formatFieldValue(value)}`}${failed ? `, ${failed} failed` : ""}\n${lines.join("\n")}`,
    { fieldId, objectType, value: clearing ? null : value, results, updated, failed },
  )
}

// ── group_by_custom_field ────────────────────────────────────────────────────

export type GroupableObjectType = "ROADMAP_ITEM" | "OPPORTUNITY"

export async function groupByCustomField({
  workspaceId,
  fieldId,
  objectType = "ROADMAP_ITEM",
  horizon,
  includeItems = true,
}: {
  workspaceId: string
  fieldId: string
  objectType?: GroupableObjectType
  horizon?: string
  includeItems?: boolean
}) {
  const prisma = getPrisma()
  const definitions = await loadCustomFieldDefinitions(prisma, { workspaceId, objectTypes: [objectType] })
  const definition = definitions.find((d) => d.id === fieldId)
  if (!definition) {
    return fail(`Custom field "${fieldId}" is not a ${objectType} custom field in this workspace. Use list_custom_field_definitions with objectType ${objectType}.`)
  }

  const objects: Array<{ id: string; title: string }> =
    objectType === "ROADMAP_ITEM"
      ? await prisma.roadmapItem.findMany({
          where: { workspaceId, status: "ACTIVE", ...(horizon ? { horizon: horizon as never } : {}) },
          select: { id: true, title: true, horizon: true },
          orderBy: [{ horizon: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
        })
      : await prisma.opportunity.findMany({
          where: { workspaceId, status: { not: "ARCHIVED" } },
          select: { id: true, title: true, status: true },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        })

  const valueRows = objects.length
    ? await prisma.customFieldValue.findMany({ where: { fieldId }, select: { objectId: true, value: true } })
    : []
  const storedById = new Map(valueRows.map((r) => [r.objectId, r.value]))

  const buckets = new Map<string, { value: CustomFieldValue; objects: Array<{ id: string; title: string }> }>()
  const UNSET = "\u0000unset"
  const add = (key: string, value: CustomFieldValue, object: { id: string; title: string }) => {
    const bucket = buckets.get(key) ?? { value, objects: [] }
    bucket.objects.push({ id: object.id, title: object.title })
    buckets.set(key, bucket)
  }
  for (const object of objects) {
    const stored = storedById.get(object.id)
    if (isUnset(stored)) {
      add(UNSET, null, object)
    } else if (Array.isArray(stored)) {
      for (const v of stored) add(`v:${String(v)}`, String(v), object)
    } else {
      add(`v:${String(stored)}`, stored as CustomFieldValue, object)
    }
  }

  const optionOrder = (definition.options ?? []).map((o) => o.value)
  const labelFor = (value: CustomFieldValue) =>
    value === null ? "(unset)" : (definition.options ?? []).find((o) => o.value === value)?.label ?? String(value)
  const entries = [...buckets.entries()].filter(([k]) => k !== UNSET)
  entries.sort(([, a], [, b]) => {
    const ai = optionOrder.indexOf(String(a.value))
    const bi = optionOrder.indexOf(String(b.value))
    if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
    return b.objects.length - a.objects.length || String(a.value).localeCompare(String(b.value))
  })
  const unsetBucket = buckets.get(UNSET)
  if (unsetBucket) entries.push([UNSET, unsetBucket])

  const groups = entries.map(([, bucket]) => ({
    value: bucket.value,
    label: labelFor(bucket.value),
    count: bucket.objects.length,
    ...(includeItems ? { items: bucket.objects } : {}),
  }))

  const noun = objectType === "ROADMAP_ITEM" ? "active roadmap items" : "non-archived opportunities"
  const text = groups.length === 0
    ? `No ${noun} to group by "${definition.name}".`
    : `**${objects.length} ${noun} by "${definition.name}"**\n` +
      groups
        .map((g) => `• **${g.label}** (${g.count})` + (includeItems && g.items ? `\n${g.items.map((i) => `    - ${i.title} [${i.id}]`).join("\n")}` : ""))
        .join("\n")
  return ok(text, {
    field: { id: definition.id, name: definition.name, fieldType: definition.fieldType, objectType },
    groups,
    totalItems: objects.length,
  })
}

