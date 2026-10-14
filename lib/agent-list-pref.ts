/**
 * Whether the full agent page's conversation list is expanded.
 *
 * Stored in a cookie rather than localStorage so the server page can read it and
 * paint the list in the right state on the first frame — the same reason
 * `sidebar_state` is a cookie. Pure: shared by the server page and the client
 * chat, so it must not touch `cookies()` or `document`.
 */
export const AGENT_LIST_COOKIE = "agent_chat_list"

/** Anything other than an explicit "0" is open, so a missing/garbled cookie shows the list. */
export function parseAgentListOpen(value: string | undefined): boolean {
  return value !== "0"
}
