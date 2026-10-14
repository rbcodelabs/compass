/**
 * Validation for workspace label overrides. Client-safe (used by the settings
 * form for instant feedback and by the server action as the authority), and also
 * run by the resolver on every read, so a stored value that no longer satisfies
 * today's rules (nav grew a section, the allowed entities changed, a manual SQL
 * edit) is ignored rather than rendered.
 *
 * The same rules that keep the UI sane keep the agent-visible vocabulary from
 * becoming a prompt-injection channel: labels are short, single-line, and limited
 * to letters, digits, combining marks, spaces and a few punctuation marks. No
 * angle brackets, quotes, backticks, control characters, or bidi/zero-width
 * characters can get through. (The MCP prose does not interpolate label text at
 * all; see lib/thinking-model/mcp.ts.)
 */

import { derivePlural, normalizeLabelText } from "./labels"
import {
  OVERRIDABLE_ENTITIES,
  THINKING_MODEL_ENTITIES,
  THINKING_MODEL_PRESETS,
  isThinkingModelKey,
  type OverridableEntity,
  type ThinkingModelEntity,
} from "./presets"

export const MAX_LABEL_LENGTH = 32
export const MIN_LABEL_LENGTH = 1
/** Serialized (UTF-8) size cap for the whole override document. */
export const MAX_OVERRIDES_BYTES = 1024
/**
 * First character a letter or number; then letters, numbers, combining marks
 * (\p{M}, so decomposed accents and Indic scripts work), spaces and ' ’ & / -.
 * Bidi and zero-width characters are format characters (Cf), not marks, so they
 * stay rejected.
 */
export const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’&/-]*$/u

/**
 * Top-level workspace sections. An entity label equal to one of these would make
 * two different places in the nav read the same. Compared after NFKC folding and
 * case-folding. __tests__/thinking-model/converted-surfaces-guard.test.ts keeps
 * this in step with the real nav.
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
  "Agents",
  "Home",
  "Updates",
  "Capture",
  "Research",
  "Feedback",
  "Settings",
  "Card sort",
  "Reviews",
]

/**
 * Other canonical nouns the UI uses for things that are not one of the five entities and are not nav sections
 * (singular and plural). Renaming an entity to one of these would make two different things read the same on screen,
 * for instance Solution -> "Assumption". Compared after NFKC folding and case-folding, like the nav names.
 */
export const RESERVED_NOUN_NAMES: readonly string[] = [
  "Experiment",
  "Experiments",
  "Assumption",
  "Assumptions",
  "Evidence",
  "Squad",
  "Squads",
  "Task",
  "Doc",
  "Decision",
  "Review",
  "Roadmap item",
  "Roadmap items",
  "Artifact",
  "Artifacts",
  "Comment",
  "Comments",
  "Member",
  "Members",
  "Workspace",
  "Workspaces",
  "Agent",
  "Agents",
  "Metric",
  "Update",
  "Study",
  "Studies",
  "Scoring model",
  "Scoring models",
]

export type LabelOverride = { singular: string; plural?: string }
export type LabelOverrides = Partial<Record<OverridableEntity, LabelOverride>>

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Shape only: allowed keys, string types, no extra keys. Hand-written rather than
 * a zod schema on purpose. This module is imported by the resolver, which the
 * client provider imports, so a zod import here would ship zod in every workspace
 * page's client bundle. (The server action keeps zod for its own input envelope.)
 */
function parseShape(input: unknown): Partial<Record<OverridableEntity, LabelOverride>> | null {
  if (!isPlainObject(input)) return null
  const out: Partial<Record<OverridableEntity, LabelOverride>> = {}
  for (const [key, entry] of Object.entries(input)) {
    if (!(OVERRIDABLE_ENTITIES as readonly string[]).includes(key)) return null
    if (entry === undefined) continue
    if (!isPlainObject(entry)) return null
    for (const field of Object.keys(entry)) if (field !== "singular" && field !== "plural") return null
    if (typeof entry.singular !== "string") return null
    if (entry.plural !== undefined && typeof entry.plural !== "string") return null
    out[key as OverridableEntity] =
      entry.plural === undefined ? { singular: entry.singular } : { singular: entry.singular, plural: entry.plural }
  }
  return out
}

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
      error: `${what} may only use letters, numbers, spaces and the characters ' ’ & / - and must start with a letter or number.`,
    }
  }
  return { ok: true, value }
}

/**
 * NFKC folds compatibility variants (full-width "ＲＯＡＤＭＡＰ", ligatures) onto
 * their plain forms, so they collide with the reserved names and with each other.
 */
const fold = (s: string) => s.normalize("NFKC").toLowerCase()

const ENTITY_NAMES: Record<ThinkingModelEntity, string> = {
  opportunity: "Opportunity",
  objective: "Objective",
  keyResult: "Key Result",
  solution: "Solution",
  cycle: "Cycle",
}

/**
 * Validates and normalizes label overrides against the preset they will sit on.
 * Collisions are checked against the EFFECTIVE labels of all five entities, so
 * renaming Objective to "Opportunity" is rejected, and under Torres a label of
 * "Outcome" cannot be reused.
 *
 * Only OVERRIDABLE_ENTITIES may be renamed; any other key is a shape error.
 */
export function validateLabelOverrides(input: unknown, presetKey: string): LabelValidationResult {
  const parsedShape = parseShape(input)
  if (!parsedShape) return fail("Labels must be an object keyed by entity, with a singular and optional plural each.")

  const preset = THINKING_MODEL_PRESETS[isThinkingModelKey(presetKey) ? presetKey : "CLASSIC"]
  const value: LabelOverrides = {}
  const reserved = new Set(RESERVED_SECTION_NAMES.map(fold))
  const reservedNouns = new Set(RESERVED_NOUN_NAMES.map(fold))
  const effective = new Map<ThinkingModelEntity, Set<string>>()

  for (const entity of THINKING_MODEL_ENTITIES) {
    const entry = parsedShape[entity]
    if (!entry) {
      effective.set(entity, new Set([fold(preset.labels[entity].singular), fold(preset.labels[entity].plural)]))
      continue
    }
    const singular = checkLabelText(entry.singular, `The ${ENTITY_NAMES[entity]} label`)
    if (!singular.ok) return fail(singular.error)
    let plural: string | undefined
    if (entry.plural !== undefined && normalizeLabelText(entry.plural) !== "") {
      const checked = checkLabelText(entry.plural, `The ${ENTITY_NAMES[entity]} plural`)
      if (!checked.ok) return fail(checked.error)
      plural = checked.value
    }
    const effectivePlural = plural ?? derivePlural(singular.value)
    for (const text of [singular.value, effectivePlural]) {
      if (reserved.has(fold(text))) return fail(`"${text}" is already the name of a section in the navigation.`)
      if (reservedNouns.has(fold(text))) return fail(`"${text}" is already the name of something else in Compass. Choose a different name.`)
    }
    value[entity] = plural ? { singular: singular.value, plural } : { singular: singular.value }
    effective.set(entity, new Set([fold(singular.value), fold(effectivePlural)]))
  }

  const owner = new Map<string, ThinkingModelEntity>()
  for (const [entity, texts] of effective) {
    for (const text of texts) {
      const other = owner.get(text)
      if (other && other !== entity) {
        return fail(
          `"${text}" would name both ${ENTITY_NAMES[other]} and ${ENTITY_NAMES[entity]}. Each entity needs its own label.`,
        )
      }
      owner.set(text, entity)
    }
  }

  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_OVERRIDES_BYTES) {
    return fail(`Labels are too long in total (limit ${MAX_OVERRIDES_BYTES} bytes).`)
  }
  return { ok: true, value }
}
