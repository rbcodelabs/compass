/**
 * Parses GET /api/agent/conversations/:id/messages for the conversation panel (TASK-195 S4).
 *
 * Everything the server computed for the signed-in person (`canEdit`, `canDelete`, `editedAt`, author type and kind) is kept,
 * because the panel hands the first load to AgentChat as its transcript: dropping those fields hid Edit on every message
 * until a poll happened to refresh the newest one. Optional fields are copied only when they have the expected type.
 */
import type { CommentTaskCardData } from "@/lib/comment-task-card"

export type PanelLoadedMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt?: string
  authorUserId?: string
  authorName?: string
  editedAt?: string
  authorType?: string
  messageKind?: string
  canEdit?: boolean
  canDelete?: boolean
}

export type ParsedConversationMessages = { messages: PanelLoadedMessage[]; taskCards: Record<string, CommentTaskCardData> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export function parseConversationMessagesResponse(body: unknown): ParsedConversationMessages | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null
  const messages = body.messages.flatMap((m): PanelLoadedMessage[] => {
    if (!isRecord(m) || typeof m.id !== "string" || typeof m.content !== "string") return []
    return [{
      id: m.id,
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
      ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
      ...(typeof m.authorUserId === "string" ? { authorUserId: m.authorUserId } : {}),
      ...(typeof m.authorName === "string" ? { authorName: m.authorName } : {}),
      ...(typeof m.editedAt === "string" ? { editedAt: m.editedAt } : {}),
      ...(typeof m.authorType === "string" ? { authorType: m.authorType } : {}),
      ...(typeof m.messageKind === "string" ? { messageKind: m.messageKind } : {}),
      ...(typeof m.canEdit === "boolean" ? { canEdit: m.canEdit } : {}),
      ...(typeof m.canDelete === "boolean" ? { canDelete: m.canDelete } : {}),
    }]
  })
  return { messages, taskCards: parseTaskCards(body.taskCards) }
}

export function parseTaskCards(value: unknown): Record<string, CommentTaskCardData> {
  if (!isRecord(value)) return {}
  const cards: Record<string, CommentTaskCardData> = {}
  for (const [messageId, card] of Object.entries(value)) {
    if (isRecord(card) && typeof card.taskId === "string" && typeof card.title === "string") cards[messageId] = card as unknown as CommentTaskCardData
  }
  return cards
}
