/**
 * User-facing wording for SPEC docs and their embeds (spec docs phase 3). Pure: no DB, no React.
 *
 * A SPEC doc has no label of its own. It is called after what it specifies: a "Spec" when it is linked to a solution, a "Discovery Plan"
 * when it is linked to an opportunity, both when (through the generic link tools) it is linked to one of each, and "Spec (unscoped)" when
 * it has no scope link left (the scope was deleted; the doc itself is untouched).
 */
import type { DocEmbedKind } from "@/lib/doc-embeds"
import type { SpecScopeType } from "@/lib/spec-docs/scopes"

export const UNSCOPED_SPEC_LABEL = "Spec (unscoped)"

export const SPEC_KIND_LABEL: Record<SpecScopeType, string> = { SOLUTION: "Spec", OPPORTUNITY: "Discovery Plan" }

/** The labels for a doc given the types of the scopes it specifies. One entry per kind present, Spec first; never empty. */
export function specKindLabels(scopeTypes: readonly SpecScopeType[]): string[] {
  const labels = (["SOLUTION", "OPPORTUNITY"] as const).filter((type) => scopeTypes.includes(type)).map((type) => SPEC_KIND_LABEL[type])
  return labels.length > 0 ? labels : [UNSCOPED_SPEC_LABEL]
}

/** Exhaustive: adding an embed kind fails the type check here. */
export const DOC_EMBED_KIND_LABEL: Record<DocEmbedKind, string> = {
  opportunity: "Opportunity",
  solution: "Solution",
  metric: "Metric",
  doc: "Doc",
  task: "Task",
  experiment: "Experiment",
  objective: "Objective",
  keyResult: "Key result",
  assumption: "Assumption",
  roadmapItem: "Roadmap item",
  artifact: "Artifact",
}

/** `IN_PROGRESS` becomes `In progress`. */
export function humanizeStatus(status: string): string {
  const words = status.replace(/[_-]+/g, " ").trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : ""
}
