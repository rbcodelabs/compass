/**
 * Formatting of what inheritance filled, for MCP tool text. Kept apart from lib/custom-field-inheritance.ts
 * (the service) so response builders depend only on this tiny pure module.
 */
import type { InheritedField } from "@/lib/custom-field-inheritance"

const OBJECT_LABEL: Record<string, string> = { OPPORTUNITY: "opportunity", SOLUTION: "solution" }

const formatValue = (value: unknown) => (Array.isArray(value) ? value.join(", ") : String(value))

/** One line per inherited field, or an empty string when nothing was inherited. */
export function inheritedFieldsText(fields: readonly InheritedField[]): string {
  if (fields.length === 0) return ""
  return (
    "\nInherited fields: " +
    fields.map((field) => `${field.fieldName} = ${formatValue(field.value)} (from ${OBJECT_LABEL[field.from.objectType] ?? field.from.objectType} field "${field.from.fieldName}")`).join("; ")
  )
}
