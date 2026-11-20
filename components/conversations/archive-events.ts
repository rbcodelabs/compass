/**
 * The panel archives a conversation; the Conversations section that lists it lives elsewhere in the page and must drop
 * (or add back) the row without a reload. A window event keeps the two decoupled: neither imports the other, and a
 * section that is not mounted simply does not hear it.
 */

export const CONVERSATION_ARCHIVE_CHANGED_EVENT = "compass:conversation-archive-changed"

export type ConversationArchiveChange = { conversationId: string; archived: boolean }

export function announceConversationArchiveChange(change: ConversationArchiveChange): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<ConversationArchiveChange>(CONVERSATION_ARCHIVE_CHANGED_EVENT, { detail: change }))
}
