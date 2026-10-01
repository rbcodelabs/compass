/**
 * Validation for workspace label overrides. Client-safe (used by the settings
 * form for instant feedback and by the server action as the authority).
 *
 * The same rules that keep the UI sane keep the agent-visible vocabulary line
 * (MCP workspace summary) from becoming a prompt-injection channel: labels are
 * short, single-line, and limited to letters, digits, spaces and a few
 * punctuation marks. No angle brackets, quotes, backticks, control characters or
 * bidi/zero-width characters can get through.
 */

import { z } from "zod"
import { derivePlural, normalizeLabelText } from "./labels"
import {
  THINKING_MODEL_ENTITIES,
  THINKING_MODEL_PRESETS,
  isThinkingModelKey,
  type ThinkingModelEntity,
} from "./presets"

export const MAX_LABEL_LENGTH = 32
export const MIN_LABEL_LENGTH = 1
/** Serialized (UTF-8) size cap for the whole override document. */
export const MAX_OVERRIDES_BYTES = 1024
export const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '’&/-]*$/u

/**
 * Top-level workspace sections. An entity label equal to one of these would make
 * two different places in the nav read the same. Case-insensitive.
 * __tests__/thinking-model/converted-surfaces-guard.test.ts keeps this in step with the real nav.
 */
export const RESERVED_SECTION_NAMES: readonly string[] = [
  "OKRs",
  "Discovery",
  "Experiments",
  "Roadmap",
  "Metrics",
  "Tasks",
  "Decisions",
  "Docs",
  "Canvas",
  "Agent",
  "Updates",
  "Capture",
  "Feedback",
  "Settings",
  "Card sort",
  "Reviews",
]

export type LabelOverride = { singular: string; plural?: string }
export type LabelOverrides = Partial<Record<ThinkingModelEntity, LabelOverride>>

const entrySchema = z.strictObject({
  singular: z.string(),
  plural: z.string().optional(),
})

const overridesShape = Object.fromEntries(
  THINKING_MODEL_ENTITIES.map((entity) => [entity, entrySchema.optional()]),
) as Record<ThinkingModelEntity, z.ZodOptional<typeof entrySchema>>

/** Shape only (allowed keys, string types). Content rules live in validateLabelOverrides. */
export const labelOverridesShapeSchema = z.strictObject(overridesShape)

export type LabelValidationResult =
  | { ok: true; value: LabelOverrides }
  | { ok: false; error: string }

const fail = (error: string): LabelValidationResult => ({ ok: false, error })

/** Returns the normalized label, or an error message. */
function checkLabelText(raw: string, what: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeLabelText(raw)
  if (value.length < MIN_LABEL_LENGTH) return { ok: false, error: `${what} cannot be empty.` }
  if ([...value].length > MAX_LABEL_LENGTH) {
    return { ok: false, error: `${what} must be at most ${MAX_LABEL_LENGTH} characters.` }
  }
  if (!LABEL_PATTERN.test(value)) {
    return {
      ok: false,
      error: `${what} may only contain letters, numbers, spaces and ' ’ & / - , and must start with a letter or number.`,
    }
  }
  return { ok: true, value }
}

const fold = (s: string) => s.normalize("NFC").toLowerCase()

/**
 * Validates and normalizes label overrides against the preset they will sit on.
 * Collisions are checked against the EFFECTIVE labels, so renaming Opportunity to
 * "Outcome" is rejected under Torres (Objective is already "Outcome") but fine
 * under Classic.
 */
export function validateLabelOverrides(input: unknown, presetKey: string): LabelValidationResult {
  const parsed = labelOverridesShapeSchema.safeParse(input)
  if (!parsed.success) return fail("Labels must be an object keyed by entity, with a singular and optional plural each.")

  const preset = THINKING_MODEL_PRESETS[isThinkingModelKey(presetKey) ? presetKey : "CLASSIC"]
  const value: LabelOverrides = {}
  const reserved = new Set(RESERVED_SECTION_NAMES.map(fold))
  const effective = new Map<ThinkingModelEntity, Set<string>>()

  for (const entity of THINKING_MODEL_ENTITIES) {
    const entry = parsed.data[entity]
    if (!entry) {
      effective.set(entity, new Set([fold(preset.labels[entity].singular), fold(preset.labels[entity].plural)]))
      continue
    }
    const singular = checkLabelText(entry.singular, `The ${entity} label`)
    if (!singular.ok) return fail(singular.error)
    let plural: string | undefined
    if (entry.plural !== undefined && normalizeLabelText(entry.plural) !== "") {
      const checked = checkLabelText(entry.plural, `The ${entity} plural`)
      if (!checked.ok) return fail(checked.error)
      plural = checked.value
    }
    const effectivePlural = plural ?? derivePlural(singular.value)
    for (const text of [singular.value, effectivePlural]) {
      if (reserved.has(fold(text))) return fail(`"${text}" is already the name of a section in the navigation.`)
    }
    value[entity] = plural ? { singular: singular.value, plural } : { singular: singular.value }
    effective.set(entity, new Set([fold(singular.value), fold(effectivePlural)]))
  }

  const owner = new Map<string, ThinkingModelEntity>()
  for (const [entity, texts] of effective) {
    for (const text of texts) {
      const other = owner.get(text)
      if (other && other !== entity) {
        return fail(`"${text}" would name both ${other} and ${entity}. Each entity needs its own label.`)
      }
      owner.set(text, entity)
    }
  }

  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_OVERRIDES_BYTES) {
    return fail(`Labels are too long in total (limit ${MAX_OVERRIDES_BYTES} bytes).`)
  }
  return { ok: true, value }
}
