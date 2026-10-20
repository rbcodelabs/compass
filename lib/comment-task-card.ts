/**
 * Client-safe shapes and display rules for the task card shown under a Doc
 * comment. No I/O here; lib/doc-comment-tasks.ts builds the data.
 */
import type { TaskPriority, TaskStatus } from "@/lib/types"

export interface CommentTaskCardData {
  taskId: string
  /** "TASK-12", or null while the row is not numbered yet. */
  displayId: string | null
  title: string
  status: TaskStatus
  priority: TaskPriority
  /** ISO date string (UTC midnight), or null. */
  dueDate: string | null
  assignee: { type: "USER" | "AGENT"; id: string; displayName: string; available: boolean } | null
}

export type CardPillTone = "neutral" | "progress" | "queued" | "review" | "done" | "blocked"

export interface CardStatus {
  label: string
  tone: CardPillTone
}

/**
 * Pill for a task card. A human assignee shows the plain task status. An agent
 * assignee shows the agent lifecycle derived from the same status (no separate
 * run state exists in v1): Queued -> Working -> Needs review -> Done.
 */
export function cardStatus(status: TaskStatus, assigneeType: "USER" | "AGENT" | null): CardStatus {
  const agent = assigneeType === "AGENT"
  switch (status) {
    case "DONE": return { label: "Done", tone: "done" }
    case "CANCELLED": return { label: "Cancelled", tone: "neutral" }
    case "BLOCKED": return { label: "Blocked", tone: "blocked" }
    case "IN_REVIEW": return { label: agent ? "Needs review" : "In review", tone: "review" }
    case "IN_PROGRESS": return { label: agent ? "Working" : "In progress", tone: "progress" }
    case "BACKLOG": return { label: agent ? "Queued" : "Backlog", tone: agent ? "queued" : "neutral" }
    case "TODO":
    default: return { label: agent ? "Queued" : "To do", tone: agent ? "queued" : "neutral" }
  }
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = { URGENT: "Urgent", HIGH: "High", MEDIUM: "Medium", LOW: "Low" }

/** "Due Oct 23" from an ISO date, formatted in UTC so the day never shifts with the viewer's zone. */
export function formatDue(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `Due ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
}

/** One-line pin kind for the anchored passage: check for a person, gear for an agent. */
export function pinKind(cards: CommentTaskCardData[]): "human" | "agent" | null {
  if (cards.length === 0) return null
  return cards.some(card => card.assignee?.type !== "AGENT") ? "human" : "agent"
}
