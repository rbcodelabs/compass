/**
 * Explicit agent participation modes for Unified Conversations (OPP-67 / SOL-117).
 *
 * - "AUTO":         Default for private 1:1 chats (`visibility === "PRIVATE"`). Agent replies on every turn.
 * - "MENTION_ONLY": Default for shared/workspace or object-anchored threads (`visibility === "WORKSPACE"`).
 *                   Plain messages save a human turn (`AgentMessage`) without starting an `AgentRun` unless
 *                   `@Compass Agent`, `@agent`, or `@<SelectedAgentName>` is mentioned.
 * - "NONE":         Human-only thread. Messages never start an `AgentRun`.
 */

export type AgentParticipationMode = "AUTO" | "MENTION_ONLY" | "NONE"
export type ConversationVisibility = "PRIVATE" | "WORKSPACE"
export type ConversationStatus = "OPEN" | "RESOLVED" | "ARCHIVED"

export function isAgentParticipationMode(value: unknown): value is AgentParticipationMode {
  return value === "AUTO" || value === "MENTION_ONLY" || value === "NONE"
}

export function isConversationVisibility(value: unknown): value is ConversationVisibility {
  return value === "PRIVATE" || value === "WORKSPACE"
}

export function isConversationStatus(value: unknown): value is ConversationStatus {
  return value === "OPEN" || value === "RESOLVED" || value === "ARCHIVED"
}

export function defaultAgentModeForVisibility(
  visibility: string | null | undefined,
  hasObjectTarget = false,
): AgentParticipationMode {
  if (visibility === "WORKSPACE" || hasObjectTarget) return "MENTION_ONLY"
  return "AUTO"
}

export function normalizeAgentParticipationMode(
  value: unknown,
  fallback: AgentParticipationMode = "AUTO",
): AgentParticipationMode {
  if (isAgentParticipationMode(value)) return value
  return fallback
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * True when `text` contains an explicit `@Compass Agent`, `@agent`, `@<agentName>`,
 * or structured `@[...](mention:agent:<uuid>)` mention token.
 */
export function messageMentionsAgent(text: string, agentName?: string | null): boolean {
  if (/(?:^|\s)@(?:compass[\s_-]*agent|agent)\b/i.test(text)) return true
  if (/@\[[^\]]+\]\(mention:agent:[0-9a-f-]{36}\)/i.test(text)) return true
  const trimmedName = agentName?.trim()
  if (trimmedName) {
    const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(trimmedName)}(?:\\b|$)`, "i")
    if (pattern.test(text)) return true
  }
  return false
}

/**
 * Decides whether a message in a conversation with `agentMode` should invoke the agent
 * or complete immediately as a passive human turn.
 */
export function shouldInvokeAgentOnTurn(params: {
  agentMode: AgentParticipationMode
  message: string
  agentName?: string | null
}): boolean {
  if (params.agentMode === "NONE") return false
  if (params.agentMode === "MENTION_ONLY") {
    return messageMentionsAgent(params.message, params.agentName)
  }
  return true
}
