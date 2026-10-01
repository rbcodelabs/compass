/**
 * Label text helpers shared by validation and resolution. Client-safe and pure.
 */

import { THINKING_MODEL_ENTITIES, type EntityLabel, type ThinkingModelEntity } from "./presets"

export type ResolvedEntityLabel = {
  singular: string
  plural: string
  lower: string
  lowerPlural: string
  /** Abbreviation where today's copy abbreviates ("KR"), otherwise the full form. */
  short: string
  shortPlural: string
  /** Sentence-case form where today's copy uses one ("Key result"), else the label as written. */
  sentence: string
  sentencePlural: string
  /** "an opportunity" for a preset label; the bare lower-case label for an override (no article). */
  indefinite: string
}

export type ResolvedLabels = Record<ThinkingModelEntity, ResolvedEntityLabel> & {
  sections: {
    /** The nav entry for /okrs ("OKRs"; the Objective plural for a model that renames Objectives). */
    okrs: string
    /** The framework word in the singular where copy uses it ("OKR"); the Objective singular when the section is derived. */
    okr: string
  }
}

/**
 * Trim, NFC-normalize and collapse runs of whitespace. Does not validate; see
 * validate.ts for the character and length rules.
 */
export function normalizeLabelText(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim()
}

/**
 * Naive English pluralization, used only when an override omits the plural.
 * Wrong for irregular nouns; the settings UI invites the user to supply a plural.
 */
export function derivePlural(singular: string): string {
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`
  return `${singular}s`
}

/**
 * Lower-case for mid-sentence use, keeping all-caps words of two or more letters
 * ("SKY", "R&D") as written so an acronym is not turned into a word.
 */
export function toLowerLabel(text: string): string {
  return text
    .split(" ")
    .map((word) => (/^[\p{Lu}\p{N}&/'’-]{2,}$/u.test(word) && /\p{Lu}.*\p{Lu}/u.test(word) ? word : word.toLowerCase()))
    .join(" ")
}

export function buildResolvedLabel(label: EntityLabel): ResolvedEntityLabel {
  const lower = toLowerLabel(label.singular)
  return {
    singular: label.singular,
    plural: label.plural,
    lower,
    lowerPlural: toLowerLabel(label.plural),
    indefinite: label.article ? `${label.article} ${lower}` : lower,
    short: label.short?.singular ?? label.singular,
    shortPlural: label.short?.plural ?? label.plural,
    sentence: label.sentence?.singular ?? label.singular,
    sentencePlural: label.sentence?.plural ?? label.plural,
  }
}

export function buildResolvedLabels(
  labels: Record<ThinkingModelEntity, EntityLabel>,
  okrsSection: string | null,
): ResolvedLabels {
  const entries = THINKING_MODEL_ENTITIES.map(
    (entity) => [entity, buildResolvedLabel(labels[entity])] as const,
  )
  const resolved = Object.fromEntries(entries) as Record<ThinkingModelEntity, ResolvedEntityLabel>
  return {
    ...resolved,
    sections: {
      okrs: okrsSection ?? resolved.objective.plural,
      okr: okrsSection === "OKRs" ? "OKR" : resolved.objective.singular,
    },
  }
}
