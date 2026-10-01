/**
 * The single resolver for "how are the entities named and related in this
 * workspace" (ADR "Thinking-model presets", mirroring isModuleEnabled).
 *
 * Pure, synchronous and TOTAL: bad JSON or an unknown key resolve to CLASSIC with
 * no overrides and never throw. NULL means CLASSIC forever. The result is plain
 * serializable data so the server layout can hand it to a client provider.
 *
 * Presentation only. Nothing server-side may branch on the result for data,
 * links or validation.
 */

import { buildResolvedLabels, derivePlural, type ResolvedLabels } from "./labels"
import {
  DEFAULT_THINKING_MODEL_KEY,
  OVERRIDABLE_ENTITIES,
  THINKING_MODEL_PRESETS,
  isThinkingModelKey,
  type CycleEmphasis,
  type EntityLabel,
  type ThinkingModelEntity,
  type ThinkingModelKey,
  type ThinkingModelPreset,
  type TreeShape,
} from "./presets"
import { validateLabelOverrides, type LabelOverrides } from "./validate"

export type ResolvedThinkingModel = {
  key: ThinkingModelKey
  name: string
  labels: ResolvedLabels
  links: ThinkingModelPreset["links"]
  tree: TreeShape
  cycles: CycleEmphasis
  /** True when the workspace stores label overrides that applied. */
  hasLabelOverrides: boolean
}

export type ThinkingModelSource = {
  thinkingModel?: string | null
  thinkingModelLabels?: string | null
}

/**
 * What is stored in the override column, under today's rules, and whether it is
 * in effect. All-or-nothing: if the stored document is not valid JSON, names an
 * entity that is not overridable, fails any validation rule (charset, length,
 * reserved nav names, uniqueness, size), or sits beside an unknown preset key,
 * NO overrides apply and the raw stored text comes back as `unapplied` so the
 * settings screen can tell an admin instead of silently showing empty fields.
 * The resolver below uses exactly this, so the form and the app cannot disagree.
 * Never throws.
 */
export type StoredLabelsStatus = { applied: LabelOverrides; unapplied: string | null }

export function inspectStoredLabels(source: ThinkingModelSource = {}): StoredLabelsStatus {
  const raw = source.thinkingModelLabels
  if (typeof raw !== "string" || raw.trim() === "") return { applied: {}, unapplied: null }
  const storedKey = source.thinkingModel
  const known = isThinkingModelKey(storedKey)
  // Overrides ride on a known key (or NULL, which is CLASSIC); an unknown key is
  // CLASSIC with no overrides.
  if (!known && storedKey != null) return { applied: {}, unapplied: raw }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { applied: {}, unapplied: raw }
  }
  const checked = validateLabelOverrides(data, known ? storedKey : DEFAULT_THINKING_MODEL_KEY)
  return checked.ok ? { applied: checked.value, unapplied: null } : { applied: {}, unapplied: raw }
}

export function resolveThinkingModel(source: ThinkingModelSource = {}): ResolvedThinkingModel {
  const known = isThinkingModelKey(source.thinkingModel)
  const key = known ? (source.thinkingModel as ThinkingModelKey) : DEFAULT_THINKING_MODEL_KEY
  const preset = THINKING_MODEL_PRESETS[key]
  const overrides = inspectStoredLabels(source).applied

  const labels = { ...preset.labels } as Record<ThinkingModelEntity, EntityLabel>
  let hasLabelOverrides = false
  for (const entity of OVERRIDABLE_ENTITIES) {
    const override = overrides[entity]
    if (!override) continue
    hasLabelOverrides = true
    // No article, no sentence/short forms: those belong to the preset's own words.
    labels[entity] = {
      singular: override.singular,
      plural: override.plural ?? derivePlural(override.singular),
    }
  }

  return {
    key,
    name: preset.name,
    labels: buildResolvedLabels(labels, preset.sections.okrs),
    links: preset.links,
    tree: preset.tree,
    cycles: preset.cycles,
    hasLabelOverrides,
  }
}

/** The CLASSIC defaults, for surfaces outside any workspace (portal, help, embed). */
export const CLASSIC_THINKING_MODEL: ResolvedThinkingModel = resolveThinkingModel({})
