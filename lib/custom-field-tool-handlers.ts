/**
 * Handler functions for Custom Field MCP tools.
 *
 * Custom Field *definitions* (and SharedFieldOptionSets) remain UI-only —
 * created and edited exclusively in Settings → Custom Fields. These tools
 * only read definitions and read/write an object's values, reusing the same
 * read boundary (lib/custom-field-definitions.ts) and the same clearing
 * semantics as the Settings UI's own write path (upsertFieldValue in
 * app/[orgSlug]/[workspaceSlug]/settings/actions.ts).
 *
 * See docs/decisions/0013-custom-field-value-mcp-management.md.
 */

import getPrisma from "@/lib/db"
import { writeCustomFieldValue } from "@/lib/custom-field-value-write"
import { listInheritanceRules } from "@/lib/custom-field-inheritance-admin"
import { customFieldInheritanceTableExists } from "@/lib/feature-tables"
import { ok, fail } from "@/lib/mcp-output"
import { resolveEntityWorkspaceId, type WorkspaceEntityType } from "@/lib/mcp-authz"
import {
  loadCustomFieldDefinitions,
  loadCustomFieldsForObject,
  toCustomFieldDefinitionData,
} from "@/lib/custom-field-definitions"
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
  CustomFieldValue,
  SelectOption,
} from "@/lib/types"

/** Every CustomFieldObjectType maps onto exactly one already-gated WorkspaceEntityType. */
export const CUSTOM_FIELD_ENTITY: Record<CustomFieldObjectType, WorkspaceEntityType> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  EXPERIMENT: "experiment",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  ROADMAP_ITEM: "roadmapItem",
  TASK: "task",
}

// ── list_custom_field_definitions ───────────────────────────────────────────

export async function listCustomFieldDefinitions({
  workspaceId,
  objectType,
}: {
  workspaceId: string
  objectType?: CustomFieldObjectType
}) {
  const definitions = await loadCustomFieldDefinitions(getPrisma(), {
    workspaceId,
    objectTypes: objectType ? [objectType] : undefined,
  })

  if (definitions.length === 0) {
    return ok("No custom field definitions found.", { items: [], count: 0 })
  }

  const lines = definitions.map((field) => {
    const requiredFlag = field.required ? "required" : "optional"
    const optionsSuffix =
      field.options && field.options.length > 0
        ? ` — options: ${field.options.map((o) => o.value).join(", ")}`
        : ""
    return `• **${field.name}** (${field.objectType}, ${field.fieldType}, ${requiredFlag}) — ID: ${field.id}${optionsSuffix}`
  })

  return ok(lines.join("\n"), { items: definitions, count: definitions.length })
}

// ── get_custom_field_values ─────────────────────────────────────────────────

export async function getCustomFieldValues({
  objectType,
  objectId,
}: {
  objectType: CustomFieldObjectType
  objectId: string
}) {
  const entityType = CUSTOM_FIELD_ENTITY[objectType]
  const workspaceId = await resolveEntityWorkspaceId(entityType, objectId)
  if (workspaceId === null) {
    return fail(`${objectType} "${objectId}" not found.`)
  }

  const fields = await loadCustomFieldsForObject(getPrisma(), {
    workspaceId,
    objectType,
    objectId,
  })

  if (fields.length === 0) {
    return ok("No custom fields are defined for this object type.", { items: [], count: 0 })
  }

  const lines = fields.map((field) => {
    const value = formatValueForDisplay(field.currentValue)
    return `• **${field.name}**: ${value} (ID: ${field.id})`
  })

  return ok(lines.join("\n"), { items: fields, count: fields.length })
}

function formatValueForDisplay(value: CustomFieldValue): string {
  if (value === null) return "(unset)"
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(unset)"
  return String(value)
}

// ── set_custom_field_value ──────────────────────────────────────────────────

export { validateValueForFieldType, isClearingValue } from "@/lib/custom-field-validation"
import { isClearingValue, validateValueForFieldType } from "@/lib/custom-field-validation"

type FieldWritePreparation =
  | { ok: true; field: CustomFieldDefinitionData; clearing: boolean }
  | { ok: false; error: string }

/**
 * The validation shared by set_custom_field_value and set_custom_field_values:
 * the field must exist, belong to the target workspace and object type, and
 * accept `value`. `subject` names the target in the workspace-mismatch message.
 */
export async function prepareFieldWrite(
  prisma: ReturnType<typeof getPrisma>,
  { workspaceId, objectType, fieldId, value, subject }: {
    workspaceId: string
    objectType: CustomFieldObjectType
    fieldId: string
    value: CustomFieldValue
    subject: string
  }
): Promise<FieldWritePreparation> {
  const fieldRow = await prisma.customFieldDefinition.findUnique({
    where: { id: fieldId },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  if (!fieldRow) {
    return { ok: false, error: `Custom field "${fieldId}" not found.` }
  }

  // Cross-tenant / cross-objectType guard. assertEntityAccess (which the tool
  // gate already ran) only verifies the OBJECT's workspace — it never looks at
  // fieldId — so without this check a caller could point a legitimate object
  // at a field definition from a workspace they aren't even a member of, or at
  // a field meant for a different object type.
  if (fieldRow.workspaceId !== workspaceId) {
    return { ok: false, error: `Custom field "${fieldId}" does not belong to the same workspace as ${subject}.` }
  }
  if (fieldRow.objectType !== objectType) {
    return { ok: false, error: `Custom field "${fieldRow.name}" is defined for ${fieldRow.objectType}, not ${objectType}.` }
  }

  const field = toCustomFieldDefinitionData(fieldRow)

  // Clearing takes priority over type validation, and must for every field
  // type — null/""/[] is how a caller says "unset this field", regardless of
  // what type it is, exactly matching upsertFieldValue's own clearing check.
  // Validating first would reject e.g. value: "" against a NUMBER field as
  // "not a number" instead of clearing it.
  const clearing = isClearingValue(value)
  if (!clearing) {
    const validationError = validateValueForFieldType(field.fieldType, field.options, value)
    if (validationError) return { ok: false, error: validationError }
  }
  return { ok: true, field, clearing }
}

export async function setCustomFieldValue({
  objectType,
  objectId,
  fieldId,
  value,
}: {
  objectType: CustomFieldObjectType
  objectId: string
  fieldId: string
  value: CustomFieldValue
}) {
  const entityType = CUSTOM_FIELD_ENTITY[objectType]
  const workspaceId = await resolveEntityWorkspaceId(entityType, objectId)
  if (workspaceId === null) {
    return fail(`${objectType} "${objectId}" not found.`)
  }

  const prisma = getPrisma()
  const prepared = await prepareFieldWrite(prisma, {
    workspaceId,
    objectType,
    fieldId,
    value,
    subject: `${objectType} "${objectId}"`,
  })
  if (!prepared.ok) return fail(prepared.error)
  const { field, clearing } = prepared

  // The single value-write funnel (also fills inheritance targets when an opportunity or solution value is set).
  await writeCustomFieldValue(prisma, { workspaceId, objectType, objectId, fieldId, value })

  const resultValue = clearing ? null : value
  return ok(
    (clearing
      ? `Cleared "${field.name}" on ${objectType} "${objectId}".`
      : `Set "${field.name}" on ${objectType} "${objectId}" to ${formatValueForDisplay(resultValue)}.`) +
      `\nID: ${fieldId}`,
    { fieldId, objectId, objectType, fieldType: field.fieldType, value: resultValue }
  )
}

// ── list_custom_field_inheritance_rules ─────────────────────────────────────

/**
 * Read-only: inheritance rules are created, reordered and deleted only in Settings → Custom Fields (ADR 0013). A
 * missing table (migration 113 not applied yet) reads as "no rules", never an error.
 */
export async function listCustomFieldInheritanceRules({ workspaceId }: { workspaceId: string }) {
  const prisma = getPrisma()
  if (!(await customFieldInheritanceTableExists(prisma))) {
    return ok("No custom field inheritance rules are defined for this workspace.", { items: [], count: 0 })
  }
  const rules = await listInheritanceRules(prisma, workspaceId)
  const items = rules.map((rule) => ({
    id: rule.id,
    priority: rule.priority,
    enabled: rule.enabled,
    status: rule.status,
    inactiveReason: rule.inactiveReason,
    sourceObjectType: rule.sourceObjectType,
    sourceField: { id: rule.sourceFieldId, name: rule.sourceFieldName },
    targetObjectType: rule.targetObjectType,
    targetField: { id: rule.targetFieldId, name: rule.targetFieldName },
  }))
  if (items.length === 0) return ok("No custom field inheritance rules are defined for this workspace.", { items, count: 0 })
  const lines = items.map(
    (item, index) =>
      `${index + 1}. ${item.targetField.name ?? "(missing field)"} on roadmap item <- ${item.sourceField.name ?? "(missing field)"} on ${item.sourceObjectType.toLowerCase()} ` +
      `(priority ${item.priority}, ${item.status}${item.inactiveReason ? `: ${item.inactiveReason}` : ""})\nID: ${item.id}`,
  )
  return ok(`**${items.length} custom field inheritance rule${items.length === 1 ? "" : "s"}** (lower priority runs first; a rule only fills an empty target and never overwrites)\n${lines.join("\n")}`, { items, count: items.length })
}
