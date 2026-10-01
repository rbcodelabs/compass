/**
 * Thinking-model presets (ADR "Thinking-model presets and typed links").
 *
 * Client-safe: pure data, no server-only imports. Presets are defined in code,
 * and a workspace stores only the preset KEY (plus optional label overrides).
 *
 * Presets are APPEND-ONLY. A workspace stores a key, so editing a preset changes
 * every workspace that uses it. Structural changes (labels, link emphasis, tree
 * shape) therefore ship as a NEW key; only typo fixes may edit an existing one.
 *
 * A preset is presentation only. Data and links are identical across presets, and
 * no server, MCP or data validation may depend on the selected preset. The `links`
 * and `requires`-style fields are a UI nudge.
 */

export const THINKING_MODEL_ENTITIES = [
  "opportunity",
  "objective",
  "keyResult",
  "solution",
  "cycle",
] as const
export type ThinkingModelEntity = (typeof THINKING_MODEL_ENTITIES)[number]

export const THINKING_MODEL_KEYS = ["CLASSIC", "OPPORTUNITY_FIRST_OKR", "TORRES_OST"] as const
export type ThinkingModelKey = (typeof THINKING_MODEL_KEYS)[number]

export const DEFAULT_THINKING_MODEL_KEY: ThinkingModelKey = "CLASSIC"

export type EntityLabel = {
  singular: string
  plural: string
  /** Abbreviated form, used where today's copy abbreviates ("KRs"). Optional. */
  short?: { singular: string; plural: string }
  /**
   * Sentence-case form ("Key result"), used where today's copy is sentence case.
   * Optional: forms without it fall back to the singular/plural as written, since
   * lower-casing user text would mangle names like "R&D need".
   */
  sentence?: { singular: string; plural: string }
  /**
   * Indefinite article ("a" / "an") for presets whose label is known, so CLASSIC
   * can say "Link to an opportunity…" exactly as before. Overrides never carry
   * one, because the article depends on text we cannot predict; their copy
   * drops it ("Link to idea…").
   */
  article?: "a" | "an"
}

/**
 * Entities a workspace may rename. Deliberately narrower than the entity list:
 * overrides must not outrun the label conversion, and these two are what Torres
 * renames and what the converted surfaces cover best. Open the others up only
 * after canvas, the discovery board and panels, the portal and help are converted.
 */
export const OVERRIDABLE_ENTITIES = ["objective", "keyResult"] as const satisfies readonly ThinkingModelEntity[]
export type OverridableEntity = (typeof OVERRIDABLE_ENTITIES)[number]

/**
 * Presets offered in the settings picker. A preset defined here but absent from this list
 * stays resolvable but cannot be newly chosen. Every preset is offered now that the
 * Opportunity<->Objective picker, the workspace tree and the Outcomes index exist.
 */
export const PICKABLE_THINKING_MODEL_KEYS = ["CLASSIC", "OPPORTUNITY_FIRST_OKR", "TORRES_OST"] as const satisfies readonly ThinkingModelKey[]

export type LinkEmphasis = "primary" | "secondary" | "hidden"
export type TreeShape = "kr-rooted" | "objective-rooted-pool" | "outcome-rooted"
/** "subdued" = never required, never prominent; shown only where data exists. */
export type CycleEmphasis = "standard" | "optional" | "subdued"

export type ThinkingModelPreset = {
  key: ThinkingModelKey
  name: string
  labels: Record<ThinkingModelEntity, EntityLabel>
  sections: {
    /**
     * The nav entry for /okrs. `null` derives it from the Objective plural, so a
     * model that calls Objectives "Outcomes" does not leave an "OKRs" entry beside them.
     */
    okrs: string | null
  }
  links: {
    oppToKr: LinkEmphasis
    oppToObjective: LinkEmphasis
    solToKr: LinkEmphasis
  }
  tree: TreeShape
  cycles: CycleEmphasis
}

const CLASSIC_LABELS: ThinkingModelPreset["labels"] = {
  opportunity: { singular: "Opportunity", plural: "Opportunities", article: "an" },
  objective: { singular: "Objective", plural: "Objectives", article: "an" },
  keyResult: {
    singular: "Key Result",
    plural: "Key Results",
    short: { singular: "KR", plural: "KRs" },
    sentence: { singular: "Key result", plural: "Key results" },
    article: "a",
  },
  solution: { singular: "Solution", plural: "Solutions", article: "a" },
  cycle: { singular: "Cycle", plural: "Cycles", article: "a" },
}

export const THINKING_MODEL_PRESETS: Readonly<Record<ThinkingModelKey, ThinkingModelPreset>> = {
  CLASSIC: {
    key: "CLASSIC",
    name: "Classic OKRs",
    labels: CLASSIC_LABELS,
    sections: { okrs: "OKRs" },
    links: { oppToKr: "primary", oppToObjective: "hidden", solToKr: "hidden" },
    tree: "kr-rooted",
    cycles: "standard",
  },
  OPPORTUNITY_FIRST_OKR: {
    key: "OPPORTUNITY_FIRST_OKR",
    name: "Opportunity-first OKRs",
    labels: CLASSIC_LABELS,
    sections: { okrs: "OKRs" },
    links: { oppToKr: "secondary", oppToObjective: "primary", solToKr: "secondary" },
    tree: "objective-rooted-pool",
    cycles: "optional",
  },
  TORRES_OST: {
    key: "TORRES_OST",
    name: "Torres opportunity solution tree",
    labels: {
      ...CLASSIC_LABELS,
      objective: { singular: "Outcome", plural: "Outcomes", article: "an" },
      keyResult: { singular: "Success metric", plural: "Success metrics", article: "a" },
    },
    sections: { okrs: null },
    links: { oppToKr: "hidden", oppToObjective: "primary", solToKr: "secondary" },
    tree: "outcome-rooted",
    cycles: "subdued",
  },
}

export function isThinkingModelKey(value: unknown): value is ThinkingModelKey {
  return typeof value === "string" && (THINKING_MODEL_KEYS as readonly string[]).includes(value)
}
