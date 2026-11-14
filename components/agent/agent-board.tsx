"use client"
// Agent board: columns by status or squad for the Agent page, with live SSE updates and rich card anatomy.

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  GitPullRequest,
  Layers,
  Loader2,
  Search,
  Sparkles,
  X,
} from "lucide-react"
import {
  Board,
  BoardColumn,
  BoardDock,
  BOARD_FADE_END_TRACK_CLASS,
  EmptyState,
  PINNED_COLUMN_BODY_CLASS,
  PINNED_COLUMN_CLASS,
} from "@/components/patterns"
import { useBoardDock } from "@/components/patterns/use-board-dock"
import { useAgentBoardColumnLayout } from "@/components/agent/agent-board-column-layout"
import {
  applyAgentBoardPatch,
  BOARD_COLUMN_LABELS,
  bucketizeBoard,
  bucketizeBoardBySquad,
  classifyBoardCard,
  filterBoardCards,
  formatRelativeTime,
  isRunHeartbeatStale,
  type AgentBoardCard,
  type AgentBoardCardLinkedObject,
  type AgentBoardCardSquad,
  type AgentBoardColumn,
  type AgentBoardPatchEvent,
  type AgentBoardSnapshotEvent,
  type BoardColumnId,
  type BoardGroupBy,
  type SquadBoardColumn,
} from "@/lib/agent-board"
import { formatPrBadge } from "@/lib/agent-card-derive"
import { cn } from "@/lib/utils"

/** Matches the chat's own poll for shared conversations (agent-chat.tsx SHARED_POLL_MS). */
const BOARD_POLL_MS = 4_000
/** Card ages and stale-heartbeat cues are coarse, so re-rendering every 15s is plenty. */
const CLOCK_TICK_MS = 15_000

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

const ENTITY_PREFIX: Record<AgentBoardCardLinkedObject["entityType"], string> = {
  OPPORTUNITY: "OPP",
  SOLUTION: "SOL",
  TASK: "TASK",
}

/** The status indicator on a card: spinner pauses and shifts to amber if worker heartbeats go stale. */
function StatusIcon({ column, staleHeartbeat = false }: { column: BoardColumnId; staleHeartbeat?: boolean }) {
  const common = "mt-0.5 size-4 shrink-0"
  switch (column) {
    case "working":
      return (
        <Loader2
          aria-hidden="true"
          data-stale={staleHeartbeat ? "true" : undefined}
          className={cn(
            common,
            staleHeartbeat ? "text-status-warning" : "text-status-info motion-safe:animate-spin",
          )}
        />
      )
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
  /** Workspace squads for the Group by: Squad mode. */
  squads?: AgentBoardCardSquad[]
  /** Called as a card is clicked, before navigation, so the shell can switch to the chat. */
  onOpenConversation: (conversationId: string) => void
  /** Optional live-card callback so the sibling Chat sidebar stays in sync when switching views. */
  onCardsChange?: (cards: AgentBoardCard[]) => void
}

/**
 * Geode's agent board, in Compass's board pattern: live SSE updates with automatic fallback to polling,
 * search across threads/subtasks/activity/linked objects, Status vs. Squad grouping, and rich cards
 * displaying inline subtask checklists, live activity or idle summaries, PR badges, and linked objects.
 */
export function AgentBoard({ workspaceId, basePath, initialCards, squads = [], onOpenConversation, onCardsChange }: AgentBoardProps) {
  const [cards, setCards] = useState<AgentBoardCard[] | null>(initialCards)
  const cardsRef = useRef<AgentBoardCard[]>(initialCards ?? [])
  const [liveSquads, setLiveSquads] = useState<AgentBoardCardSquad[]>(squads)
  const [failed, setFailed] = useState(false)
  const [sseFallback, setSseFallback] = useState(() => typeof EventSource === "undefined")
  const [searchQuery, setSearchQuery] = useState("")
  const [groupBy, setGroupBy] = useState<BoardGroupBy>("status")
  const [now, setNow] = useState(() => Date.now())
  const lastBody = useRef<string | null>(initialCards ? JSON.stringify({ cards: initialCards }) : null)
  // Polls can overlap on a slow connection; only the newest request may write, so an older answer never overwrites a newer one.
  const latestRequest = useRef(0)

  const refresh = useCallback(async (withSquads = false) => {
    const request = ++latestRequest.current
    try {
      const qs = new URLSearchParams({ workspaceId })
      if (withSquads) qs.set("includeSquads", "1")
      const res = await fetch(`/api/agent/board?${qs.toString()}`)
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
      const body = JSON.parse(text) as { cards?: AgentBoardCard[]; squads?: AgentBoardCardSquad[] }
      const nextCards = body.cards ?? []
      cardsRef.current = nextCards
      setCards(nextCards)
      onCardsChange?.(nextCards)
      if (body.squads) setLiveSquads(body.squads)
    } catch {
      // A missed tick costs a few seconds; the next one catches up.
      setFailed(true)
    }
  }, [workspaceId, onCardsChange])

  // Primary transport: workspace-scoped SSE stream (`/api/agent/board/stream`) when EventSource is available.
  useEffect(() => {
    if (typeof EventSource === "undefined") return

    let closed = false
    let source: EventSource | null = null

    const connect = () => {
      if (closed) return
      const es = new EventSource(`/api/agent/board/stream?workspaceId=${encodeURIComponent(workspaceId)}`)
      source = es

      es.addEventListener("snapshot", (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as AgentBoardSnapshotEvent
          setFailed(false)
          setSseFallback(false)
          cardsRef.current = data.cards
          lastBody.current = JSON.stringify({ cards: data.cards })
          setCards(data.cards)
          onCardsChange?.(data.cards)
        } catch {
          /* ignore malformed frame */
        }
      })

      es.addEventListener("patch", (ev: MessageEvent) => {
        try {
          const patch = JSON.parse(ev.data) as AgentBoardPatchEvent
          setFailed(false)
          const next = applyAgentBoardPatch(cardsRef.current, patch)
          cardsRef.current = next
          lastBody.current = JSON.stringify({ cards: next })
          setCards(next)
          onCardsChange?.(next)
        } catch {
          /* ignore malformed frame */
        }
      })

      es.addEventListener("reconnect", () => {
        es.close()
        if (!closed) connect()
      })

      es.onerror = () => {
        es.close()
        if (!closed) {
          setSseFallback(true)
        }
      }
    }

    connect()
    return () => {
      closed = true
      source?.close()
    }
  }, [workspaceId, onCardsChange])

  // Fallback polling (or tab-visibility catch-up) + coarse clock tick for relative ages & stale-heartbeat cue.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisible)

    let first: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    if (sseFallback) {
      first = setTimeout(() => void refresh(), 0)
      poll = setInterval(() => {
        if (document.visibilityState === "visible") void refresh()
      }, BOARD_POLL_MS)
    }

    return () => {
      if (first) clearTimeout(first)
      if (poll) clearInterval(poll)
      clearInterval(clock)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh, sseFallback])

  const filteredCards = useMemo(() => filterBoardCards(cards ?? [], searchQuery), [cards, searchQuery])
  const columns = useMemo(() => bucketizeBoard(filteredCards), [filteredCards])
  const squadColumns = useMemo(
    () => bucketizeBoardBySquad(filteredCards, liveSquads),
    [filteredCards, liveSquads],
  )
  const columnById = useMemo(
    () => new Map<string, AgentBoardColumn>(columns.map((column) => [column.id, column])),
    [columns],
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const dock = useBoardDock({
    controller: useAgentBoardColumnLayout(workspaceId),
    renderedIds: columns.map((column) => column.id),
    labelOf: (id) => BOARD_COLUMN_LABELS[id as BoardColumnId],
    containerRef,
  })

  if (cards === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-text-subtle" role="status">
        {failed ? "Couldn't load the board. Retrying…" : "Loading board…"}
      </div>
    )
  }

  function renderStatusColumn(column: AgentBoardColumn, placement: "scroller" | "pinned") {
    const pinned = placement === "pinned"
    return (
      <BoardColumn
        key={column.id}
        data-board-column={column.id}
        title={column.label}
        count={column.cards.length}
        accent={COLUMN_ACCENT[column.id]}
        layoutControls={dock.layoutControlsFor(column.id)}
        className={pinned ? PINNED_COLUMN_CLASS : "w-[calc(100cqw-3.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-4rem)] md:h-full md:w-72 md:min-w-[280px] md:flex-1"}
        bodyClassName={pinned ? `${PINNED_COLUMN_BODY_CLASS} py-1` : "min-h-44 py-1 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"}
      >
        {column.cards.length === 0 ? (
          <EmptyState compact title={searchQuery.trim() ? "No matching chats." : EMPTY_COPY[column.id]} />
        ) : (
          column.cards.map((card) => (
            <BoardCard
              key={card.id}
              card={card}
              column={column.id}
              showSquadBadge
              now={now}
              href={`${basePath}/agent?c=${card.id}`}
              onOpen={() => onOpenConversation(card.id)}
            />
          ))
        )}
      </BoardColumn>
    )
  }

  function renderSquadColumn(column: SquadBoardColumn) {
    return (
      <BoardColumn
        key={column.id}
        data-board-column={`squad:${column.id}`}
        title={column.label}
        count={column.cards.length}
        accent="neutral"
        className="w-[calc(100cqw-3.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-4rem)] md:h-full md:w-72 md:min-w-[280px] md:flex-1"
        bodyClassName="min-h-44 py-1 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"
      >
        {column.cards.length === 0 ? (
          <EmptyState compact title={searchQuery.trim() ? "No matching chats." : "No chats in this squad."} />
        ) : (
          column.cards.map((card) => (
            <BoardCard
              key={card.id}
              card={card}
              column={classifyBoardCard(card)}
              showSquadBadge={false}
              now={now}
              href={`${basePath}/agent?c=${card.id}`}
              onOpen={() => onOpenConversation(card.id)}
            />
          ))
        )}
      </BoardColumn>
    )
  }

  const dockTabs = groupBy === "status" ? dock.dockTabsFor((id) => columnById.get(id)?.cards.length ?? 0) : []
  const activeColumn = groupBy === "status" && dock.dockOpen && dock.activeDockId ? columnById.get(dock.activeDockId) : undefined

  return (
    <div ref={containerRef} data-testid="agent-board" className="flex min-h-0 flex-1 flex-col bg-surface-panel">
      {/* Search + Group by toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-default bg-surface-panel px-3 py-2 sm:px-4">
        <div className="relative flex min-w-[200px] max-w-sm flex-1 items-center">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 size-3.5 text-text-subtle" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search agent threads"
            placeholder="Search threads, tasks, activity…"
            className="h-8 w-full rounded-lg border border-border-default bg-surface-card pl-8 pr-7 text-xs text-text-primary placeholder:text-text-subtle focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              className="absolute right-2 rounded p-0.5 text-text-subtle hover:text-text-primary"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Group board by">
          <span className="hidden items-center gap-1 text-xs text-text-subtle sm:inline-flex">
            <Layers aria-hidden="true" className="size-3.5" />
            Group:
          </span>
          <div className="inline-flex rounded-lg border border-border-default bg-surface-inset p-0.5 text-xs">
            <button
              type="button"
              aria-pressed={groupBy === "status"}
              onClick={() => setGroupBy("status")}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium",
                groupBy === "status"
                  ? "bg-surface-card text-text-primary shadow-xs"
                  : "text-text-subtle hover:text-text-primary",
              )}
            >
              Status
            </button>
            <button
              type="button"
              aria-pressed={groupBy === "squad"}
              onClick={() => {
                setGroupBy("squad")
                if (liveSquads.length === 0) void refresh(true)
              }}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium",
                groupBy === "squad"
                  ? "bg-surface-card text-text-primary shadow-xs"
                  : "text-text-subtle hover:text-text-primary",
              )}
            >
              Squad
            </button>
          </div>
        </div>
      </div>

      {failed && (
        <p role="status" className="shrink-0 px-4 pt-2 text-xs text-status-warning">
          Couldn&apos;t refresh just now. Showing the last update.
        </p>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        {groupBy === "status" ? (
          <>
            <Board
              label="Agent conversations by status"
              fadeEnd={dock.dockedIds.length > 0}
              className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
            >
              <div
                className={cn(
                  "flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3",
                  dock.dockedIds.length > 0 && BOARD_FADE_END_TRACK_CLASS,
                )}
              >
                {dock.scrollerIds
                  .map((id) => columnById.get(id))
                  .filter((column): column is AgentBoardColumn => Boolean(column))
                  .map((column) => renderStatusColumn(column, "scroller"))}
              </div>
            </Board>
            {dockTabs.length > 0 ? (
              <BoardDock
                tabs={dockTabs}
                activeId={dock.activeDockId}
                collapsed={!dock.dockOpen}
                onSelectTab={dock.selectDockTab}
                panel={activeColumn ? renderStatusColumn(activeColumn, "pinned") : null}
              />
            ) : null}
          </>
        ) : (
          <Board
            label="Agent conversations by squad"
            className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
          >
            <div className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3">
              {squadColumns.map((column) => renderSquadColumn(column))}
            </div>
          </Board>
        )}
      </div>
    </div>
  )
}

function BoardCard({
  card,
  column,
  showSquadBadge,
  now,
  href,
  onOpen,
}: {
  card: AgentBoardCard
  column: BoardColumnId
  showSquadBadge: boolean
  now: number
  href: string
  onOpen: () => void
}) {
  const label = BOARD_COLUMN_LABELS[column]
  const staleHeartbeat = isRunHeartbeatStale(card, now)
  const prBadge = formatPrBadge(card.prUrl)
  const subtasks = card.subtasks && card.subtasks.total > 0 ? card.subtasks : null
  const linkedObjects = card.linkedObjects && card.linkedObjects.length > 0 ? card.linkedObjects : null
  const extraLinkedCount = Math.max(0, (card.linkedObjectCount ?? 0) - (linkedObjects?.length ?? 0))

  const liveLine =
    column === "working"
      ? card.currentActivity || (staleHeartbeat ? "Heartbeat delayed · awaiting worker…" : null)
      : null
  const idleSummary = column !== "working" ? (card.summary ?? null) : null

  return (
    <Link
      href={href}
      onClick={onOpen}
      data-board-card={card.id}
      data-column={column}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-border-default bg-surface-card p-3 shadow-[var(--shadow-card)] transition",
        "hover:border-border-strong hover:shadow-[var(--shadow-panel)] focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        column === "new" && "border-l-[3px] border-l-status-warning",
      )}
    >
      <StatusIcon column={column} staleHeartbeat={staleHeartbeat} />
      <span className="min-w-0 flex-1">
        {/* Title + optional Squad pill */}
        <span className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 text-sm font-medium leading-5 text-text-primary">
            {card.title || "Untitled chat"}
          </span>
          {showSquadBadge && card.squad && (
            <span
              data-testid="board-card-squad-badge"
              className="inline-flex max-w-[96px] shrink-0 items-center gap-1 rounded-full border border-border-default bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: card.squad.color }}
              />
              <span className="truncate">{card.squad.name}</span>
            </span>
          )}
        </span>

        {/* Live activity line (working) or 1-2 line outcome excerpt (idle) */}
        {liveLine && (
          <span
            data-testid="board-card-live-activity"
            className={cn(
              "mt-1 block truncate text-xs",
              staleHeartbeat ? "text-status-warning" : "text-text-secondary",
            )}
          >
            {liveLine}
          </span>
        )}
        {idleSummary && (
          <span
            data-testid="board-card-summary"
            className="mt-1 line-clamp-2 block text-xs leading-relaxed text-text-secondary"
          >
            {idleSummary}
          </span>
        )}

        {/* Inline Subtask Progress Checklist */}
        {subtasks && (
          <span
            data-testid="board-card-subtasks"
            className="mt-2 block rounded-lg border border-border-default/70 bg-surface-inset/70 p-2"
          >
            <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-text-subtle">
              <span>Subtasks</span>
              <span className="tabular-nums">
                {subtasks.completed}/{subtasks.total}
              </span>
            </span>
            <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-border-default/60">
              <span
                className={cn(
                  "block h-full rounded-full transition-all",
                  subtasks.completed === subtasks.total ? "bg-status-success" : "bg-status-info",
                )}
                style={{ width: `${Math.round((subtasks.completed / subtasks.total) * 100)}%` }}
              />
            </span>
            <span className="mt-1.5 flex flex-col gap-1">
              {subtasks.items.map((item) => (
                <span key={item.id} className="flex items-center gap-1.5 text-[11px] leading-4">
                  {item.status === "completed" ? (
                    <CheckCircle2 aria-hidden="true" className="size-3 shrink-0 text-status-success" />
                  ) : item.status === "in_progress" ? (
                    <Loader2 aria-hidden="true" className="size-3 shrink-0 text-status-info motion-safe:animate-spin" />
                  ) : (
                    <Circle aria-hidden="true" className="size-3 shrink-0 text-text-disabled" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      item.status === "completed"
                        ? "text-text-subtle line-through"
                        : item.status === "in_progress"
                          ? "font-medium text-text-primary"
                          : "text-text-secondary",
                    )}
                  >
                    {item.title}
                  </span>
                </span>
              ))}
              {subtasks.total > subtasks.items.length && (
                <span className="pl-4 text-[10px] text-text-subtle">
                  +{subtasks.total - subtasks.items.length} more
                </span>
              )}
            </span>
          </span>
        )}

        {/* Linked Compass objects + GitHub PR chips */}
        {(prBadge || linkedObjects) && (
          <span className="mt-2 flex flex-wrap items-center gap-1">
            {prBadge && (
              <span
                data-testid="board-card-pr-badge"
                title={prBadge.repo}
                className="inline-flex items-center gap-1 rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 text-[11px] font-medium text-text-primary"
              >
                <GitPullRequest aria-hidden="true" className="size-3 text-status-info" />
                <span>{prBadge.label}</span>
              </span>
            )}
            {linkedObjects?.map((obj) => (
              <span
                key={`${obj.entityType}:${obj.entityId}`}
                data-testid="board-card-linked-chip"
                className="inline-flex max-w-[160px] items-center gap-1 rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 text-[11px] text-text-secondary"
              >
                <span className="font-semibold text-[10px] text-text-subtle">{ENTITY_PREFIX[obj.entityType]}</span>
                <span className="truncate">{obj.title}</span>
              </span>
            ))}
            {extraLinkedCount > 0 && (
              <span className="rounded-md bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-subtle">
                +{extraLinkedCount}
              </span>
            )}
          </span>
        )}

        {/* Footer metadata */}
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-text-subtle">
          <span>{staleHeartbeat ? "Delayed" : label}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={card.lastActivityAt} suppressHydrationWarning>
            {formatRelativeTime(card.lastActivityAt, now)}
          </time>
          {card.messageCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {card.messageCount} {card.messageCount === 1 ? "msg" : "msgs"}
              </span>
            </>
          )}
        </span>
      </span>
    </Link>
  )
}
