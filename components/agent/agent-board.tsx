"use client"
// Agent board: columns by status for the Agent page (see lib/agent-board.ts for the bucketing rules).

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, CheckCircle2, Circle, Loader2, Sparkles } from "lucide-react"
import { Board, BoardColumn, EmptyState } from "@/components/patterns"
import {
  bucketizeBoard,
  formatRelativeTime,
  type AgentBoardCard,
  type BoardColumnId,
} from "@/lib/agent-board"
import { cn } from "@/lib/utils"

/** Matches the chat's own poll for shared conversations (agent-chat.tsx SHARED_POLL_MS). */
const BOARD_POLL_MS = 4_000
/** Card ages are coarse (minutes), so re-rendering them more often than this buys nothing. */
const CLOCK_TICK_MS = 30_000

const COLUMN_ACCENT: Record<BoardColumnId, "neutral" | "info" | "success" | "warning" | "danger"> = {
  working: "info",
  new: "warning",
  done: "success",
  failed: "danger",
  ready: "neutral",
}

const EMPTY_COPY: Record<BoardColumnId, string> = {
  working: "Nothing running right now.",
  new: "Nothing new to review.",
  done: "Nothing reviewed yet.",
  failed: "Nothing failed.",
  ready: "No empty chats.",
}

/** The status indicator on a card: the spinner is what makes a Working card read as alive. */
function StatusIcon({ column }: { column: BoardColumnId }) {
  const common = "mt-0.5 size-4 shrink-0"
  switch (column) {
    case "working":
      return <Loader2 aria-hidden="true" className={cn(common, "text-status-info motion-safe:animate-spin")} />
    case "failed":
      return <AlertCircle aria-hidden="true" className={cn(common, "text-status-danger")} />
    case "new":
      return <Sparkles aria-hidden="true" className={cn(common, "text-status-warning")} />
    case "done":
      return <CheckCircle2 aria-hidden="true" className={cn(common, "text-status-success")} />
    case "ready":
      return <Circle aria-hidden="true" className={cn(common, "text-text-disabled")} />
  }
}

type AgentBoardProps = {
  workspaceId: string
  basePath: string
  /** The server-painted cards when the board is the first view; null when it is opened later. */
  initialCards: AgentBoardCard[] | null
  /** Called as a card is clicked, before navigation, so the shell can switch to the chat. */
  onOpenConversation: (conversationId: string) => void
}

/**
 * Geode's agent board, in Compass's board pattern: one column per status (Working and New always shown, the
 * rest only when they hold something), cards newest-activity-first, horizontally scrolling at a minimum
 * column width so a narrow screen scrolls rather than squashes. Which column a card is in is decided by
 * lib/agent-board.ts; this component only draws it and keeps it fresh by polling.
 */
export function AgentBoard({ workspaceId, basePath, initialCards, onOpenConversation }: AgentBoardProps) {
  const [cards, setCards] = useState<AgentBoardCard[] | null>(initialCards)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const lastBody = useRef<string | null>(initialCards ? JSON.stringify({ cards: initialCards }) : null)
  // Polls can overlap on a slow connection; only the newest request may write, so an older answer never overwrites a newer one.
  const latestRequest = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current
    try {
      const res = await fetch(`/api/agent/board?workspaceId=${encodeURIComponent(workspaceId)}`)
      if (request !== latestRequest.current) return
      if (!res.ok) {
        setFailed(true)
        return
      }
      const text = await res.text()
      if (request !== latestRequest.current) return
      setFailed(false)
      // An unchanged poll must not re-render the whole board (and reset a column's scroll position).
      if (text === lastBody.current) return
      lastBody.current = text
      const body = JSON.parse(text) as { cards?: AgentBoardCard[] }
      setCards(body.cards ?? [])
    } catch {
      // A missed tick costs a few seconds; the next one catches up.
      setFailed(true)
    }
  }, [workspaceId])

  useEffect(() => {
    // Always refresh on mount: the first view may have been painted from stale server props, or from nothing.
    const first = setTimeout(() => void refresh(), 0)
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, BOARD_POLL_MS)
    const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    // Coming back to the tab should not wait for the next tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearTimeout(first)
      clearInterval(poll)
      clearInterval(clock)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  const columns = useMemo(() => bucketizeBoard(cards ?? []), [cards])

  if (cards === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-text-subtle" role="status">
        {failed ? "Couldn't load the board. Retrying…" : "Loading board…"}
      </div>
    )
  }

  return (
    <div data-testid="agent-board" className="flex min-h-0 flex-1 flex-col bg-surface-panel">
      {failed && (
        <p role="status" className="shrink-0 px-4 pt-2 text-xs text-status-warning">
          Couldn&apos;t refresh just now. Showing the last update.
        </p>
      )}
      <Board
        label="Agent conversations by status"
        // Same frame as the Tasks board: the board scrolls horizontally, and below md the page scrolls vertically.
        className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
      >
        <div className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3">
          {columns.map((column) => (
            <BoardColumn
              key={column.id}
              data-board-column={column.id}
              title={column.label}
              count={column.cards.length}
              accent={COLUMN_ACCENT[column.id]}
              // One column nearly fills the screen below md and the next peeks in (a scroll cue); from md they sit at a
              // 280px minimum and the board scrolls once they no longer fit, instead of squashing.
              className="w-[calc(100cqw-3.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-4rem)] md:h-full md:w-72 md:min-w-[280px] md:flex-1"
              // py gives a card's shadow room inside the scroll box, so the first and last card are not clipped.
              bodyClassName="min-h-44 py-1 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"
            >
              {column.cards.length === 0 ? (
                <EmptyState compact title={EMPTY_COPY[column.id]} />
              ) : (
                column.cards.map((card) => (
                  <BoardCard
                    key={card.id}
                    card={card}
                    column={column.id}
                    now={now}
                    href={`${basePath}/agent?c=${card.id}`}
                    onOpen={() => onOpenConversation(card.id)}
                  />
                ))
              )}
            </BoardColumn>
          ))}
        </div>
      </Board>
    </div>
  )
}

function BoardCard({
  card,
  column,
  now,
  href,
  onOpen,
}: {
  card: AgentBoardCard
  column: BoardColumnId
  now: number
  href: string
  onOpen: () => void
}) {
  const label = column.charAt(0).toUpperCase() + column.slice(1)
  return (
    <Link
      href={href}
      onClick={onOpen}
      data-board-card={card.id}
      data-column={column}
      className={cn(
        "flex items-start gap-2 rounded-xl border border-border-default bg-surface-card p-3 shadow-[var(--shadow-card)] transition",
        "hover:border-border-strong hover:shadow-[var(--shadow-panel)] focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        // Geode's "unreviewed" cue: a New card carries an accent edge so the ones that need a look stand out.
        column === "new" && "border-l-[3px] border-l-status-warning"
      )}
    >
      <StatusIcon column={column} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-medium leading-5 text-text-primary">{card.title || "Untitled chat"}</span>
        <span className="mt-1 flex items-center gap-1.5 text-xs text-text-subtle">
          <span>{label}</span>
          <span aria-hidden="true">·</span>
          {/* "now" differs between the server render and hydration, so the age text may legitimately differ. */}
          <time dateTime={card.lastActivityAt} suppressHydrationWarning>{formatRelativeTime(card.lastActivityAt, now)}</time>
        </span>
      </span>
    </Link>
  )
}
