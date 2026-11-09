/**
 * Pure custom-field value validation, shared by the MCP tools, the Settings UI write path and the inheritance
 * service. Kept in a leaf module (no database, no MCP imports) so the inheritance service can use it without an
 * import cycle through lib/custom-field-tool-handlers.ts, which re-exports both functions for existing callers.
 */
import type { CustomFieldType, CustomFieldValue, SelectOption } from "@/lib/types"

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

export function isClearingValue(value: CustomFieldValue): boolean {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0)
}
