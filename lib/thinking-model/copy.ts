/**
 * Shared copy templates for phrases that need an article. Living here, not
 * inline in components, so a test can pin them against today's literals and the
 * components cannot drift from what that test checks.
 *
 * A preset label carries its article, so CLASSIC reads exactly as it always has
 * ("Link to an opportunity…"). A workspace override has none, so it reads
 * "Link to idea…" rather than guessing a/an.
 */
import type { ResolvedEntityLabel, ResolvedLabels } from "./labels"
import { CLASSIC_THINKING_MODEL } from "./resolve"

/** Combobox call-to-action: "Link to a key result…". */
export const linkToPlaceholder = (label: ResolvedEntityLabel) => `Link to ${label.indefinite}…`

/** The opportunity composer's variant, without "to": "Link a key result". */
export const linkPlaceholder = (label: ResolvedEntityLabel) => `Link ${label.indefinite}`

/** "Linked to a key result" (rail row indicator). */
export const linkedToLabel = (label: ResolvedEntityLabel) => `Linked to ${label.indefinite}`

/**
 * The word for the root node of a per-opportunity tree legend. Today's copy says "Outcome" there for an unrenamed Key
 * Result (main's historical text, kept byte-identical under CLASSIC); a model or workspace that renames Key Result is
 * not contradicted, so it shows that name (Torres: "Success metric").
 */
export const ostLegendRootLabel = (labels: ResolvedLabels) =>
  labels.keyResult.singular === CLASSIC_THINKING_MODEL.labels.keyResult.singular ? "Outcome" : labels.keyResult.singular

/**
 * "an Objective" / "a Key Result": the preset's article before the label as written (not lower-cased), for
 * sentence copy that capitalizes the entity today. An override has no article, so it is the bare label.
 */
export const indefiniteTitle = (label: ResolvedEntityLabel) => {
  const article = /^(an?) /.exec(label.indefinite)
  return article ? `${article[1]} ${label.singular}` : label.singular
}
