import type { EntityType } from "@/lib/entity-detail"
import type { EntityLinkType as EntityUrlType } from "@/lib/entity-links"
import type { WorkspaceEntityType } from "@/lib/mcp-authz"

/**
 * The one entity-type vocabulary for generic links (ADR "One generic entity_links table for
 * association links", section 3). It is exactly COMMENT_TARGET_TYPES plus METRIC, RESEARCH_TURN and AGENT_CONVERSATION.
 *
 * Written out here, not imported from lib/comments.ts: that module pulls in the notification
 * emitter, and lib/followable.ts already documents (and pins with a test) the same duplication to
 * avoid an import cycle. __tests__/entity-types.test.ts pins this list to COMMENT_TARGET_TYPES.
 *
 * lib/entity-links.ts (URL addressing) already exports a type called `EntityLinkType`; nothing in
 * this module or lib/links/ may reuse that name.
 */
export const ENTITY_TYPE_VOCABULARY = [
  "OBJECTIVE", "KEY_RESULT", "OPPORTUNITY", "SOLUTION", "ASSUMPTION",
  "EXPERIMENT", "ROADMAP_ITEM", "FEEDBACK_ITEM", "TASK", "DOC", "ARTIFACT",
  "RESEARCH_STUDY", "REVIEW_REQUEST", "METRIC", "RESEARCH_TURN",
  // Agent conversations: only the CONVERSATION_* link types (lib/agent-conversation-links.ts) use it. It has no access-control
  // mapping on purpose, so the generic link tools can never read or write a conversation endpoint.
  "AGENT_CONVERSATION",
  // A comment (the shared `comments` table or the Doc `doc_comments` table): only the TASK_CREATED_FROM link type uses it. Like
  // AGENT_CONVERSATION it has no access-control mapping and is not in the public schemas, so the generic tools never name it.
  "COMMENT",
] as const

export type LinkableEntityType = (typeof ENTITY_TYPE_VOCABULARY)[number]

/**
 * The types the PUBLIC generic link surface (REST and the MCP link_entities / list_links tools) accepts. AGENT_CONVERSATION is internal:
 * its link types are written and read only by lib/links/conversation-links.ts, which applies the conversation access rules, so it is
 * left out of the public schemas (and the generated REST client stays unchanged).
 */
export type PublicLinkEntityType = Exclude<LinkableEntityType, "AGENT_CONVERSATION" | "COMMENT">
export const PUBLIC_LINK_ENTITY_TYPES = ENTITY_TYPE_VOCABULARY.filter((type): type is PublicLinkEntityType => type !== "AGENT_CONVERSATION" && type !== "COMMENT") as unknown as readonly [PublicLinkEntityType, ...PublicLinkEntityType[]]

export function isLinkableEntityType(value: unknown): value is LinkableEntityType {
  return typeof value === "string" && (ENTITY_TYPE_VOCABULARY as readonly string[]).includes(value)
}

/**
 * Task links call a review request `DECISION`. Every other vocabulary consumer says
 * `REVIEW_REQUEST`, so inputs are normalised here and the alias never reaches a stored row.
 */
export const ENTITY_TYPE_ALIASES: Readonly<Record<string, LinkableEntityType>> = { DECISION: "REVIEW_REQUEST" }

/** Resolves an alias, then validates against the vocabulary. Null for anything unknown. */
export function normalizeEntityType(value: string): LinkableEntityType | null {
  const resolved = ENTITY_TYPE_ALIASES[value] ?? value
  return isLinkableEntityType(resolved) ? resolved : null
}

/** The camelCase panel `EntityType` (lib/entity-detail.ts). Types without a detail panel map to null. */
const PANEL_ENTITY_TYPE: Record<LinkableEntityType, EntityType | null> = {
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ASSUMPTION: "assumption",
  EXPERIMENT: "experiment",
  ROADMAP_ITEM: "roadmapItem",
  FEEDBACK_ITEM: "feedback",
  TASK: "task",
  DOC: null,
  ARTIFACT: null,
  RESEARCH_STUDY: null,
  REVIEW_REQUEST: null,
  METRIC: null,
  RESEARCH_TURN: null,
  AGENT_CONVERSATION: null,
  COMMENT: null,
}

export function toPanelEntityType(type: LinkableEntityType): EntityType | null {
  return PANEL_ENTITY_TYPE[type]
}

/** The type lib/entity-links.ts uses to build an in-app URL (panel types plus doc and artifact), or null. */
export function toUrlEntityType(type: LinkableEntityType): EntityUrlType | null {
  if (type === "DOC") return "doc"
  if (type === "ARTIFACT") return "artifact"
  return PANEL_ENTITY_TYPE[type]
}

/** The access-control entity type (lib/mcp-authz.ts) for the MCP gates. METRIC and RESEARCH_TURN have no workspace resolver there. */
const WORKSPACE_ENTITY_TYPE: Record<LinkableEntityType, WorkspaceEntityType | null> = {
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ASSUMPTION: "assumption",
  EXPERIMENT: "experiment",
  ROADMAP_ITEM: "roadmapItem",
  FEEDBACK_ITEM: "feedbackItem",
  TASK: "task",
  DOC: "doc",
  ARTIFACT: "artifact",
  RESEARCH_STUDY: "researchStudy",
  REVIEW_REQUEST: "reviewRequest",
  METRIC: null,
  RESEARCH_TURN: null,
  AGENT_CONVERSATION: null,
  COMMENT: null,
}

export function toWorkspaceEntityType(type: LinkableEntityType): WorkspaceEntityType | null {
  return WORKSPACE_ENTITY_TYPE[type]
}
