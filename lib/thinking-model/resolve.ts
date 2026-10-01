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

import { buildResolvedLabels, derivePlural, normalizeLabelText, type ResolvedLabels } from "./labels"
import {
  DEFAULT_THINKING_MODEL_KEY,
  THINKING_MODEL_ENTITIES,
  THINKING_MODEL_PRESETS,
  isThinkingModelKey,
  type CycleEmphasis,
  type EntityLabel,
  type ThinkingModelEntity,
  type ThinkingModelKey,
  type ThinkingModelPreset,
  type TreeShape,
} from "./presets"
import { LABEL_PATTERN, MAX_LABEL_LENGTH, type LabelOverrides } from "./validate"

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

/** Lenient read of a stored override column. Invalid entries are dropped, never thrown. */
export function parseStoredLabelOverrides(raw: string | null | undefined): LabelOverrides {
  if (!raw) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {}
  const out: LabelOverrides = {}
  for (const entity of THINKING_MODEL_ENTITIES) {
    const entry = (data as Record<string, unknown>)[entity]
    if (typeof entry !== "object" || entry === null) continue
    const { singular, plural } = entry as { singular?: unknown; plural?: unknown }
    const s = typeof singular === "string" ? normalizeLabelText(singular) : ""
    if (!s || [...s].length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(s)) continue
    const p = typeof plural === "string" ? normalizeLabelText(plural) : ""
    const validPlural = p && [...p].length <= MAX_LABEL_LENGTH && LABEL_PATTERN.test(p)
    out[entity] = validPlural ? { singular: s, plural: p } : { singular: s }
  }
  return out
}

export function resolveThinkingModel(source: ThinkingModelSource = {}): ResolvedThinkingModel {
  const known = isThinkingModelKey(source.thinkingModel)
  const key = known ? (source.thinkingModel as ThinkingModelKey) : DEFAULT_THINKING_MODEL_KEY
  const preset = THINKING_MODEL_PRESETS[key]
  // Overrides ride on a known key only; an unknown key is CLASSIC with no overrides.
  const overrides = known || source.thinkingModel == null ? parseStoredLabelOverrides(source.thinkingModelLabels) : {}

  const labels = { ...preset.labels } as Record<ThinkingModelEntity, EntityLabel>
  let hasLabelOverrides = false
  for (const entity of THINKING_MODEL_ENTITIES) {
    const override = overrides[entity]
    if (!override) continue
    hasLabelOverrides = true
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
