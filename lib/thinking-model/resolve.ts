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
 * Read a stored override column under today's rules. All-or-nothing: if the
 * stored document is not valid JSON, names an entity that is not overridable, or
 * fails any validation rule (charset, length, reserved nav names, uniqueness,
 * size), NO overrides apply. That re-checks on every read, so the settings
 * action need not be the only line of defence. Never throws.
 */
export function parseStoredLabelOverrides(
  raw: string | null | undefined,
  presetKey: string = DEFAULT_THINKING_MODEL_KEY,
): LabelOverrides {
  if (!raw) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  const checked = validateLabelOverrides(data, presetKey)
  return checked.ok ? checked.value : {}
}

export function resolveThinkingModel(source: ThinkingModelSource = {}): ResolvedThinkingModel {
  const known = isThinkingModelKey(source.thinkingModel)
  const key = known ? (source.thinkingModel as ThinkingModelKey) : DEFAULT_THINKING_MODEL_KEY
  const preset = THINKING_MODEL_PRESETS[key]
  // Overrides ride on a known key only; an unknown key is CLASSIC with no overrides.
  const overrides = known || source.thinkingModel == null ? parseStoredLabelOverrides(source.thinkingModelLabels, key) : {}

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
