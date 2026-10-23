/**
 * The agent board's bucketing, ported from Geode's kanban (`bucketize()` and
 * `classifyThreadRow()`): which column a conversation lands in, how columns are
 * ordered, and which are shown. Pure and import-safe from client components.
 *
 * A conversation's column comes from its LATEST run plus a per-user "reviewed" instant:
 *
 *   Working  latest run QUEUED / RUNNING
 *   Failed   latest run FAILED / INTERRUPTED (a new turn is what clears it, as in Geode)
 *   New      idle, has messages, and not reviewed since its last activity
 *   Done     idle, has messages, reviewed at or after its last activity
 *   Ready    no messages yet
 *
 * "Reviewed since last activity" is a timestamp comparison rather than a boolean, so a
 * new assistant message or run after review makes the card New again with no write.
 */

export type BoardColumnId = "working" | "failed" | "new" | "done" | "ready"

export const BOARD_COLUMN_LABELS: Record<BoardColumnId, string> = {
  working: "Working",
  new: "New",
  done: "Done",
  failed: "Failed",
  ready: "Ready",
}

/** Geode's order: in-flight first, then what needs a look, then settled, then failures. */
const COLUMN_ORDER: BoardColumnId[] = ["working", "new", "done", "failed", "ready"]

/** Shown even when empty, so the board never reads as broken. Every other empty column is hidden. */
const ALWAYS_SHOWN: ReadonlySet<BoardColumnId> = new Set(["working", "new"])

/** One conversation as the board sees it. Timestamps are ISO strings so it serializes to the client. */
export type AgentBoardCard = {
  id: string
  title: string | null
  messageCount: number
  /** Status of the most recent run, or null if it never ran. */
  runStatus: string | null
  /** Latest of the conversation's `updatedAt` and its latest run's status change. */
  lastActivityAt: string
  /** When THIS user last reviewed it, or null. Never another participant's. */
  reviewedAt: string | null
}

export type AgentBoardColumn = { id: BoardColumnId; label: string; cards: AgentBoardCard[] }

function time(iso: string | null): number {
  if (!iso) return Number.NaN
  return Date.parse(iso)
}

export function classifyBoardCard(card: Pick<AgentBoardCard, "runStatus" | "messageCount" | "lastActivityAt" | "reviewedAt">): BoardColumnId {
  if (card.runStatus === "QUEUED" || card.runStatus === "RUNNING") return "working"
  if (card.runStatus === "FAILED" || card.runStatus === "INTERRUPTED") return "failed"
  if (card.messageCount <= 0) return "ready"
  const reviewed = time(card.reviewedAt)
  const activity = time(card.lastActivityAt)
  // NaN compares false, so a garbled timestamp reads as unreviewed: surfacing a card is the safe failure.
  return reviewed >= activity ? "done" : "new"
}

export function bucketizeBoard(cards: readonly AgentBoardCard[]): AgentBoardColumn[] {
  const buckets = new Map<BoardColumnId, AgentBoardCard[]>(COLUMN_ORDER.map((id) => [id, []]))
  for (const card of cards) buckets.get(classifyBoardCard(card))!.push(card)

  return COLUMN_ORDER.flatMap((id) => {
    const bucket = buckets.get(id)!
    if (bucket.length === 0 && !ALWAYS_SHOWN.has(id)) return []
    const sorted = [...bucket].sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt))
    return [{ id, label: BOARD_COLUMN_LABELS[id], cards: sorted }]
  })
}

/** Geode's `relativeTime`: coarse on purpose, a board does not need seconds. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso))
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
