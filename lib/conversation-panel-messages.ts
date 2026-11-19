/**
 * Parses GET /api/agent/conversations/:id/messages for the conversation panel (TASK-195 S4).
 *
 * Everything the server computed for the signed-in person (`canEdit`, `canDelete`, `editedAt`, author type and kind) is kept,
 * because the panel hands the first load to AgentChat as its transcript: dropping those fields hid Edit on every message
 * until a poll happened to refresh the newest one. Optional fields are copied only when they have the expected type.
 */
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import type { TaskPriority, TaskStatus } from "@/lib/types"

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

const STATUSES = new Set(["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE", "CANCELLED"])
const PRIORITIES = new Set(["URGENT", "HIGH", "MEDIUM", "LOW"])

/** Rebuilds a card field by field from untrusted JSON: anything off-shape drops the card, extra fields never pass through. */
function parseCard(card: unknown): CommentTaskCardData | null {
  if (!isRecord(card)) return null
  const { taskId, displayId, title, status, priority, dueDate, assignee } = card
  if (typeof taskId !== "string" || !taskId || typeof title !== "string") return null
  if (typeof status !== "string" || !STATUSES.has(status) || typeof priority !== "string" || !PRIORITIES.has(priority)) return null
  if (displayId !== null && displayId !== undefined && typeof displayId !== "string") return null
  if (dueDate !== null && dueDate !== undefined && typeof dueDate !== "string") return null
  let parsedAssignee: CommentTaskCardData["assignee"] = null
  if (assignee !== null && assignee !== undefined) {
    if (!isRecord(assignee) || (assignee.type !== "USER" && assignee.type !== "AGENT") || typeof assignee.id !== "string" || typeof assignee.displayName !== "string" || typeof assignee.available !== "boolean") return null
    parsedAssignee = {
      type: assignee.type, id: assignee.id, displayName: assignee.displayName, available: assignee.available,
      ...(assignee.agentKind === "CLOUD" || assignee.agentKind === "EXTERNAL" ? { agentKind: assignee.agentKind } : {}),
    }
  }
  return { taskId, displayId: typeof displayId === "string" ? displayId : null, title, status: status as TaskStatus, priority: priority as TaskPriority, dueDate: typeof dueDate === "string" ? dueDate : null, assignee: parsedAssignee }
}

export function parseTaskCards(value: unknown): Record<string, CommentTaskCardData> {
  if (!isRecord(value)) return {}
  const cards: Record<string, CommentTaskCardData> = {}
  for (const [messageId, raw] of Object.entries(value)) {
    const card = parseCard(raw)
    if (card) cards[messageId] = card
  }
  return cards
}
