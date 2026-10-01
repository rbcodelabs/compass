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
}

export type ResolvedLabels = Record<ThinkingModelEntity, ResolvedEntityLabel> & {
  sections: { okrs: string }
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

export function buildResolvedLabel(label: EntityLabel): ResolvedEntityLabel {
  return {
    singular: label.singular,
    plural: label.plural,
    lower: label.singular.toLowerCase(),
    lowerPlural: label.plural.toLowerCase(),
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
  return { ...resolved, sections: { okrs: okrsSection ?? resolved.objective.plural } }
}
