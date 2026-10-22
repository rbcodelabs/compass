/**
 * The Spec and Discovery Plan document templates, held in code (like GTM_POSITIONING_BRIEF_TEMPLATE) and rendered from a snapshot of
 * the scope's real records. Pure and deterministic: the same snapshot always yields the same markdown, and an empty section is just its
 * heading. References are written with the slice-1 embed syntax (`[title](compass://kind/uuid)`, one per paragraph so each renders as a
 * block card) through lib/doc-embeds, never by hand-built strings.
 *
 * `Doc.metadata.template` (`spec@1` / `discovery-plan@1`) records which template produced a doc. It is informational frontmatter only:
 * nothing branches on it.
 */
import { normalizeEmbedTitle, serializeEmbed, type DocEmbedKind } from "@/lib/doc-embeds"
import type { SpecScopeType } from "@/lib/spec-docs/scopes"

export const SPEC_TEMPLATE_ID = "spec@1"
export const DISCOVERY_PLAN_TEMPLATE_ID = "discovery-plan@1"

/** A record the template embeds: id plus the title cached into the link. */
export type SpecRecord = { id: string; title: string }

export type SpecTemplateData =
  | {
      scopeType: "SOLUTION"
      solution: SpecRecord
      keyResults: SpecRecord[]
      assumptions: SpecRecord[]
      experiments: SpecRecord[]
      artifacts: SpecRecord[]
    }
  | {
      scopeType: "OPPORTUNITY"
      opportunity: SpecRecord
      keyResults: SpecRecord[]
      objectives: SpecRecord[]
      solutions: SpecRecord[]
      assumptions: SpecRecord[]
      experiments: SpecRecord[]
      artifacts: SpecRecord[]
    }

/** `default` fills the sections from the scope's records; `blank` writes the same headings with no embeds. */
export const SPEC_TEMPLATE_VARIANTS = ["default", "blank"] as const
export type SpecTemplateVariant = (typeof SPEC_TEMPLATE_VARIANTS)[number]

export function specTemplateId(scopeType: SpecScopeType): string {
  return scopeType === "SOLUTION" ? SPEC_TEMPLATE_ID : DISCOVERY_PLAN_TEMPLATE_ID
}

const embed = (kind: DocEmbedKind, record: SpecRecord) =>
  serializeEmbed({ kind, id: record.id, title: normalizeEmbedTitle(record.title) ?? "Untitled" })

type Section = { heading: string; embeds: string[] }

const render = (sections: Section[]): string =>
  sections.map((s) => [`## ${s.heading}`, ...s.embeds].join("\n\n")).join("\n\n") + "\n"

const unlessBlank = (variant: SpecTemplateVariant, embeds: () => string[]): string[] => (variant === "blank" ? [] : embeds())

/** The markdown body for a scope. */
export function renderSpecTemplate(data: SpecTemplateData, variant: SpecTemplateVariant = "default"): string {
  if (data.scopeType === "SOLUTION") {
    return render([
      { heading: "Problem and outcome", embeds: unlessBlank(variant, () => data.keyResults.map((r) => embed("keyResult", r))) },
      { heading: "Solution", embeds: unlessBlank(variant, () => [embed("solution", data.solution)]) },
      { heading: "Assumptions", embeds: unlessBlank(variant, () => data.assumptions.map((r) => embed("assumption", r))) },
      { heading: "Experiments", embeds: unlessBlank(variant, () => data.experiments.map((r) => embed("experiment", r))) },
      { heading: "Prototypes", embeds: unlessBlank(variant, () => data.artifacts.map((r) => embed("artifact", r))) },
      { heading: "Open questions", embeds: [] },
      { heading: "Decision log", embeds: [] },
    ])
  }
  return render([
    {
      heading: "Outcome",
      embeds: unlessBlank(variant, () => [...data.keyResults.map((r) => embed("keyResult", r)), ...data.objectives.map((r) => embed("objective", r))]),
    },
    { heading: "Opportunity", embeds: unlessBlank(variant, () => [embed("opportunity", data.opportunity)]) },
    { heading: "Solutions under consideration", embeds: unlessBlank(variant, () => data.solutions.map((r) => embed("solution", r))) },
    { heading: "Riskiest assumptions", embeds: unlessBlank(variant, () => data.assumptions.map((r) => embed("assumption", r))) },
    { heading: "Experiment plan", embeds: unlessBlank(variant, () => data.experiments.map((r) => embed("experiment", r))) },
    { heading: "Prototypes", embeds: unlessBlank(variant, () => data.artifacts.map((r) => embed("artifact", r))) },
    { heading: "Open questions", embeds: [] },
  ])
}

const MAX_TITLE = 255

/**
 * `Spec - <solution title>` or `Discovery Plan - <opportunity title>`, plus the optional label in parentheses. Capped at the column
 * width by shortening the scope title (counted in code points), so the label is never the part that is cut.
 */
export function specDocTitle(scopeType: SpecScopeType, scopeTitle: string, label?: string | null): string {
  const prefix = scopeType === "SOLUTION" ? "Spec - " : "Discovery Plan - "
  const cleanLabel = normalizeEmbedTitle(label ?? undefined)
  const suffix = cleanLabel ? ` (${cleanLabel})` : ""
  const room = Math.max(0, MAX_TITLE - Array.from(prefix).length - Array.from(suffix).length)
  const title = Array.from(normalizeEmbedTitle(scopeTitle) ?? "Untitled").slice(0, room).join("")
  return Array.from(`${prefix}${title}${suffix}`).slice(0, MAX_TITLE).join("")
}
