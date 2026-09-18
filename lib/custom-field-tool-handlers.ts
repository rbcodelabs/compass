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
import { ok, fail } from "@/lib/mcp-output"
import { resolveEntityWorkspaceId, type WorkspaceEntityType } from "@/lib/mcp-authz"
import {
  loadCustomFieldDefinitions,
  loadCustomFieldsForObject,
  toCustomFieldDefinitionData,
} from "@/lib/custom-field-definitions"
import type {
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

/**
 * Validates `value` against a field's declared type (and, for picklists, its
 * currently defined options). Returns a specific, actionable error message on
 * failure, or null when the value is acceptable. There is no server-side
 * equivalent of this validation anywhere else in the codebase — the Settings
 * UI only constrains input by rendering a type-appropriate widget, so an MCP
 * caller (which sends raw JSON, not a widget) needs its own check.
 */
export function validateValueForFieldType(
  fieldType: CustomFieldType,
  options: SelectOption[] | null,
  value: unknown
): string | null {
  if (value === null) return null

  switch (fieldType) {
    case "TEXT":
    case "URL":
      if (typeof value !== "string") {
        return `Expected a string value for a ${fieldType} field, got ${typeof value}.`
      }
      return null

    case "NUMBER":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `Expected a finite number for a NUMBER field, got ${JSON.stringify(value)}.`
      }
      return null

    case "BOOLEAN":
      if (typeof value !== "boolean") {
        return `Expected a boolean value for a BOOLEAN field, got ${typeof value}.`
      }
      return null

    case "DATE":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        return `Expected a date string for a DATE field, got ${JSON.stringify(value)}.`
      }
      return null

    case "SELECT": {
      if (value === "") return null
      if (typeof value !== "string") {
        return `Expected a string option value for a SELECT field, got ${typeof value}.`
      }
      const allowed = (options ?? []).map((o) => o.value)
      if (!allowed.includes(value)) {
        return `"${value}" is not one of this field's defined options: ${allowed.join(", ") || "(none defined)"}.`
      }
      return null
    }

    case "MULTI_SELECT": {
      if (!Array.isArray(value)) {
        return `Expected an array of option values for a MULTI_SELECT field, got ${typeof value}.`
      }
      const allowed = (options ?? []).map((o) => o.value)
      const invalid = value.filter((entry) => typeof entry !== "string" || !allowed.includes(entry))
      if (invalid.length > 0) {
        return `${JSON.stringify(invalid)} are not among this field's defined options: ${allowed.join(", ") || "(none defined)"}.`
      }
      return null
    }

    default:
      return `Unknown field type: ${fieldType}.`
  }
}

function isClearingValue(value: CustomFieldValue): boolean {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0)
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
  const fieldRow = await prisma.customFieldDefinition.findUnique({
    where: { id: fieldId },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  if (!fieldRow) {
    return fail(`Custom field "${fieldId}" not found.`)
  }

  // Cross-tenant / cross-objectType guard. assertEntityAccess (which the tool
  // gate already ran) only verifies the OBJECT's workspace — it never looks at
  // fieldId — so without this check a caller could point a legitimate object
  // at a field definition from a workspace they aren't even a member of, or at
  // a field meant for a different object type.
  if (fieldRow.workspaceId !== workspaceId) {
    return fail(
      `Custom field "${fieldId}" does not belong to the same workspace as ${objectType} "${objectId}".`
    )
  }
  if (fieldRow.objectType !== objectType) {
    return fail(
      `Custom field "${fieldRow.name}" is defined for ${fieldRow.objectType}, not ${objectType}.`
    )
  }

  const field = toCustomFieldDefinitionData(fieldRow)

  const validationError = validateValueForFieldType(field.fieldType, field.options, value)
  if (validationError) {
    return fail(validationError)
  }

  const clearing = isClearingValue(value)

  if (clearing) {
    await prisma.customFieldValue.deleteMany({ where: { fieldId, objectId } })
  } else {
    await prisma.customFieldValue.upsert({
      where: { fieldId_objectId: { fieldId, objectId } },
      create: { fieldId, objectId, value: value as object },
      update: { value: value as object, updatedAt: new Date() },
    })
  }

  const resultValue = clearing ? null : value
  return ok(
    clearing
      ? `Cleared "${field.name}" on ${objectType} "${objectId}".`
      : `Set "${field.name}" on ${objectType} "${objectId}" to ${formatValueForDisplay(resultValue)}.`,
    { fieldId, objectId, objectType, fieldType: field.fieldType, value: resultValue }
  )
}
