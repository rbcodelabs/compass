/**
 * The surfaces that keep Compass's standard entity names (Opportunity, Objective, Key Result, Solution, Cycle) in every
 * preset and under every label override. This is the ONE list the settings notice and the thinking-models help page are
 * built from, so the two cannot disagree; __tests__/thinking-model/converted-surfaces-guard.test.ts ties each entry that
 * names files to the source tree, so a surface cannot silently move between "converted" and "canonical".
 *
 * Client-safe, pure data, no imports.
 *
 * `summary` reads as the continuation of "Standard names are still used in ...".
 */
export type CanonicalSurface = {
  id: string
  /** Short phrase for the settings notice and the docs list. */
  summary: string
  /** Why it stays canonical, for the docs page and for reviewers. */
  reason: string
  /** The specific items, where the category is a list rather than a whole area. */
  details?: readonly string[]
}

export const REMAINING_CANONICAL_SURFACES: readonly CanonicalSurface[] = [
  {
    id: "agents-and-api",
    summary: "agent (MCP) tools, their descriptions and their output text, and the API",
    reason:
      "Agents and integrations rely on one stable vocabulary. The workspace's names reach agents only as structured data (thinkingModel.labels), never inside prose.",
  },
  {
    id: "public-surfaces",
    summary: "the public portal, shared roadmaps, embeds and the marketing site",
    reason: "These are seen by people outside the workspace, who do not share its vocabulary.",
  },
  {
    id: "help-and-docs",
    summary: "help and documentation text (other than the thinking models page itself)",
    reason: "Help describes the product as it ships, in its standard terms.",
  },
  {
    id: "research-and-agent-chat",
    summary: "research studies, the PM interview, the voice agent and the agent chat",
    reason: "Their prompts and generated copy are written for agents and respondents, not for the workspace's own screens.",
  },
  {
    id: "account-and-org-pages",
    summary: "the sign-in, onboarding and organization-level pages, which sit outside any one workspace",
    reason: "They are shown before or above a workspace, so there is no workspace vocabulary to apply.",
  },
  {
    id: "server-messages",
    summary: "a few server error messages raised where the workspace's names are not available",
    reason:
      "These messages are thrown by server actions or shared with the agent tools, and the code that raises them does not read the workspace's names.",
    details: [
      "Opportunity not found, Solution not found, Solution opportunity mismatch and Solution squad mismatch (Roadmap, Feedback and Discovery actions)",
      "Solution not found in opportunity, and This workspace has no active Solution scoring model (Discovery actions)",
      "The parent Key Result rules when linking an Objective: not found, same objective, closed cycle, time horizon, circular hierarchy",
      "Link errors shared with the agent tools: Opportunity, Solution, Objective and Key Result not found",
      "The card sort message for proposing a new entry outside an Opportunity round, and This field is not an Opportunity field on the board",
    ],
  },
  {
    id: "internal-identifiers",
    summary: "URLs (such as /okrs and /discovery), stored values, analytics event names and the internal component gallery",
    reason: "These are identifiers or developer tooling, not product copy; renaming identifiers would break links and data.",
  },
]

/** Settings notice text, derived from the list above. */
export function remainingCanonicalNotice(): string {
  const items = REMAINING_CANONICAL_SURFACES.map((s) => s.summary)
  const list = items.length > 1 ? `${items.slice(0, -1).join("; ")}; and ${items[items.length - 1]}` : (items[0] ?? "")
  return `Standard names are still used in: ${list}.`
}
