/**
 * Pure rule-compatibility check shared by rule creation (Settings), the list views and the apply-time guard.
 * A rule is only meaningful while source and target have the same field type and, for pick lists, every
 * option the source can hold exists on the target. Options can drift after a rule was created, so this runs
 * again at apply time (ADR risk 4) and when rules are listed.
 */
import type { SelectOption } from "@/lib/types"

export type InheritanceTargetType = "ROADMAP_ITEM"
export type InheritanceSourceType = "OPPORTUNITY" | "SOLUTION"

/** Phase 1 pairs. The table carries both object types so more pairs need no schema change; this allow-list is the gate. */
export const SUPPORTED_INHERITANCE_PAIRS = [
  { target: "ROADMAP_ITEM", source: "OPPORTUNITY", linkColumn: "opportunityId" },
  { target: "ROADMAP_ITEM", source: "SOLUTION", linkColumn: "solutionId" },
] as const

export type RuleIncompatibility = { reason: "type_mismatch" | "options_mismatch"; message: string }

type FieldShape = { fieldType: string; options: SelectOption[] | { value: string }[] | null }

export function describeRuleIncompatibility(source: FieldShape, target: FieldShape): RuleIncompatibility | null {
  if (source.fieldType !== target.fieldType) {
    return { reason: "type_mismatch", message: `Source and target fields must have the same type (${source.fieldType} vs ${target.fieldType}).` }
  }
  if (source.fieldType === "SELECT" || source.fieldType === "MULTI_SELECT") {
    const available = new Set((target.options ?? []).map((option) => option.value))
    const missing = (source.options ?? []).map((option) => option.value).filter((value) => !available.has(value))
    if (missing.length > 0) {
      return { reason: "options_mismatch", message: `Options mismatch: the target field has no option for ${missing.map((value) => `"${value}"`).join(", ")}.` }
    }
  }
  return null
}

/** The human-readable message for an incompatible pair, or null when the pair is compatible. */
export function checkRuleCompatibility(source: FieldShape, target: FieldShape): string | null {
  return describeRuleIncompatibility(source, target)?.message ?? null
}
