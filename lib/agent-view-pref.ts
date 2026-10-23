/**
 * Which view the full agent page shows: the Chat, or the Board of conversations by status.
 *
 * Stored in a cookie for the same reason as `agent_chat_list` (lib/agent-list-pref.ts): the server
 * page reads it and paints the right view on the first frame, with no flash. Pure, so the server page
 * and the client shell can share it; it must not touch `cookies()` or `document`.
 */
export const AGENT_VIEW_COOKIE = "agent_view"

export type AgentView = "chat" | "board"

/** Only an explicit "board" is the board, so a missing or garbled cookie shows the chat. */
export function parseAgentView(value: string | undefined): AgentView {
  return value === "board" ? "board" : "chat"
}

/**
 * A `?c=<conversation>` URL is a deep link to a conversation (the rail's "open full page", a board card, a
 * shared link), so it always shows the chat; the saved view only decides a plain `/agent` load.
 */
export function resolveInitialAgentView(cookieValue: string | undefined, conversationId: string | undefined): AgentView {
  if (conversationId) return "chat"
  return parseAgentView(cookieValue)
}
