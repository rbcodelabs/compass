"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { X } from "lucide-react"
import { usePanelContext, type PanelType } from "@/components/panels/panel-context"
import { Button } from "@/components/ui/button"
import { humanizeValue } from "@/lib/notification-text"
import { markLiveNotificationRead } from "@/lib/notifications-live-client"
import {
  EMPTY_LIVE_CARDS,
  dismissLiveNotificationCard,
  getLiveNotificationCards,
  subscribeLiveNotificationCards,
  type LiveNotificationCard,
} from "@/lib/ui/live-notification-cards"
import { initialsOf } from "@/lib/user-initials"
import { cn } from "@/lib/utils"

const PANEL_TYPE_BY_SUBJECT: Readonly<Record<string, PanelType>> = {
  TASK: "task",
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ASSUMPTION: "assumption",
  EXPERIMENT: "experiment",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  FEEDBACK_ITEM: "feedback",
  REVIEW_REQUEST: "review",
}

const CARD_AUTO_DISMISS_MS = 10_000

export function subjectPanelType(subjectType: string): PanelType | null {
  return PANEL_TYPE_BY_SUBJECT[subjectType] ?? null
}

function priorityPillClasses(priority: string): string {
  switch (priority.toUpperCase()) {
    case "URGENT":
      return "bg-status-danger-surface text-status-danger"
    case "HIGH":
      return "bg-status-warning-surface text-status-warning"
    default:
      return "bg-status-neutral-surface text-status-neutral"
  }
}

function formatRelativeTime(iso: string, nowMs: number | null): string {
  if (nowMs === null) return "Just now"
  const createdMs = new Date(iso).getTime()
  if (Number.isNaN(createdMs)) return "Just now"
  const diffSec = Math.max(0, Math.floor((nowMs - createdMs) / 1000))
  if (diffSec < 60) return "Just now"
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

/**
 * Studio Quiet Hybrid Option A + Option C top-right live notification card stack.
 * Single cards render the Editorial Inset layout (`Open in panel ↗` + `Mark read`);
 * bursts of 2+ personal alerts automatically collapse into a 3D peeking deck with
 * `+N more in stack · Expand` / `Collapse stack`.
 */
export function LiveNotificationCardHost({
  orgSlug,
  workspaceSlug,
}: {
  orgSlug: string
  workspaceSlug: string
}) {
  const allCards = useSyncExternalStore(
    subscribeLiveNotificationCards,
    getLiveNotificationCards,
    () => EMPTY_LIVE_CARDS,
  )
  const cards = allCards.filter(
    (card) => card.orgSlug === orgSlug && card.workspaceSlug === workspaceSlug,
  )

  const [expanded, setExpanded] = useState(false)
  const [stackHovered, setStackHovered] = useState(false)
  const [nowMs, setNowMs] = useState<number | null>(null)

  useEffect(() => {
    if (cards.length === 0) return
    const immediate = window.setTimeout(() => setNowMs(Date.now()), 0)
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => {
      window.clearTimeout(immediate)
      window.clearInterval(timer)
    }
  }, [cards.length])

  const isBurst = cards.length > 1
  const isExpanded = expanded && isBurst

  return (
    <div
      data-testid="live-notification-stack"
      role="region"
      aria-label="Live notifications"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 top-16 flex flex-col items-end sm:left-auto sm:right-4 sm:w-[23.5rem] md:top-4"
      // Body-level floating layer above side panels (60), dialogs (70), and UndoToastHost (90).
      style={{ zIndex: 95 }}
      onMouseEnter={() => setStackHovered(true)}
      onMouseLeave={() => setStackHovered(false)}
    >
      {cards.length === 1 && (
        <LiveNotificationCardItem
          key={cards[0].id}
          card={cards[0]}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          index={0}
          totalCards={1}
          isExpanded={false}
          stackHovered={stackHovered}
          nowMs={nowMs}
          onResetExpanded={() => setExpanded(false)}
          className="live-notification-enter"
        />
      )}

      {isBurst && !isExpanded && (
        <div className="flex w-full flex-col items-end gap-2">
          <div className={cn("relative w-full", cards.length >= 3 ? "pb-5" : "pb-2.5")}>
            {cards.slice(0, 3).map((card, index) => (
              <LiveNotificationCardItem
                key={card.id}
                card={card}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                index={index}
                totalCards={cards.length}
                isExpanded={false}
                stackHovered={stackHovered}
                nowMs={nowMs}
                onResetExpanded={() => setExpanded(false)}
                ariaHidden={index > 0}
                className={
                  index === 0
                    ? "live-notification-enter relative z-30"
                    : index === 1
                      ? "pointer-events-none absolute inset-x-0 bottom-0 z-20 max-h-full origin-bottom translate-y-2.5 scale-[0.96] opacity-85"
                      : "pointer-events-none absolute inset-x-0 bottom-0 z-10 max-h-full origin-bottom translate-y-5 scale-[0.92] opacity-60"
                }
              />
            ))}
          </div>
          <Button
            variant="outline"
            size="xs"
            data-testid="live-notification-deck-toggle"
            className="pointer-events-auto h-7 rounded-full border-border-strong bg-surface-card px-3 text-[11.5px] font-semibold text-text-primary hover:bg-surface-inset"
            style={{ boxShadow: "var(--shadow-panel)" }}
            onClick={() => setExpanded(true)}
          >
            +{cards.length - 1} more in stack · Expand
          </Button>
        </div>
      )}

      {isBurst && isExpanded && (
        <div className="flex w-full flex-col items-end gap-2">
          <div className="pointer-events-auto flex max-h-[calc(100dvh-7rem)] w-full flex-col gap-2.5 overflow-y-auto">
            {cards.map((card, index) => (
              <LiveNotificationCardItem
                key={card.id}
                card={card}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                index={index}
                totalCards={cards.length}
                isExpanded={true}
                stackHovered={stackHovered}
                nowMs={nowMs}
                onResetExpanded={() => setExpanded(false)}
                className="live-notification-enter shrink-0"
              />
            ))}
          </div>
          <Button
            variant="outline"
            size="xs"
            data-testid="live-notification-deck-toggle"
            className="pointer-events-auto h-7 rounded-full border-border-strong bg-surface-card px-3 text-[11.5px] font-semibold text-text-primary hover:bg-surface-inset"
            style={{ boxShadow: "var(--shadow-panel)" }}
            onClick={() => setExpanded(false)}
          >
            Collapse stack
          </Button>
        </div>
      )}
    </div>
  )
}

function LiveNotificationCardItem({
  card,
  orgSlug,
  workspaceSlug,
  index,
  totalCards,
  isExpanded,
  stackHovered,
  nowMs,
  onResetExpanded,
  ariaHidden,
  className,
}: {
  card: LiveNotificationCard
  orgSlug: string
  workspaceSlug: string
  index: number
  totalCards: number
  isExpanded: boolean
  stackHovered: boolean
  nowMs: number | null
  onResetExpanded: () => void
  ariaHidden?: boolean
  className?: string
}) {
  const router = useRouter()
  const { openPanel } = usePanelContext()
  const [cardFocused, setCardFocused] = useState(false)

  const isAgent = card.actorType === "AGENT"
  const panelType = subjectPanelType(card.subjectType)
  const isBackgroundCollapsed = !isExpanded && index > 0
  const isPaused = stackHovered || cardFocused || isBackgroundCollapsed

  const remainingMsRef = useRef(CARD_AUTO_DISMISS_MS)
  const totalCardsRef = useRef(totalCards)
  const onResetExpandedRef = useRef(onResetExpanded)

  useEffect(() => {
    totalCardsRef.current = totalCards
    onResetExpandedRef.current = onResetExpanded
  }, [totalCards, onResetExpanded])

  useEffect(() => {
    if (isPaused) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => {
      if (totalCardsRef.current <= 2) onResetExpandedRef.current()
      dismissLiveNotificationCard(card.id)
    }, remainingMsRef.current)
    return () => {
      window.clearTimeout(timer)
      const elapsed = Math.max(0, Date.now() - startedAt)
      remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed)
    }
  }, [card.id, isPaused])

  function maybeCollapseAfterRemoval() {
    if (totalCards <= 2) onResetExpanded()
  }

  function handleDismiss() {
    maybeCollapseAfterRemoval()
    dismissLiveNotificationCard(card.id)
  }

  function handleMarkRead() {
    maybeCollapseAfterRemoval()
    void markLiveNotificationRead(orgSlug, workspaceSlug, card.id)
  }

  function handleOpen() {
    maybeCollapseAfterRemoval()
    void markLiveNotificationRead(orgSlug, workspaceSlug, card.id)
    if (panelType !== null) {
      openPanel(panelType, card.subjectId)
      return
    }
    const cleanPath = card.path.replace(/^\/+/, "")
    router.push(`/${orgSlug}/${workspaceSlug}/${cleanPath}`)
  }

  return (
    <article
      data-testid="live-notification-card"
      data-card-id={card.id}
      aria-hidden={ariaHidden ? "true" : undefined}
      onFocusCapture={() => setCardFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setCardFocused(false)
        }
      }}
      className={cn(
        "pointer-events-auto relative w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground transition-all duration-200 hover:border-border-strong",
        className,
      )}
      style={{ boxShadow: "var(--shadow-panel)" }}
    >
      <div className="flex flex-col gap-2.5 px-3.5 pt-3 pb-2.5">
        {/* Header row */}
        <div className="flex items-center gap-2.5">
          <div
            aria-hidden="true"
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold",
              isAgent
                ? "bg-[var(--agent-accent-surface)] text-[13px] text-[var(--agent-accent)]"
                : "bg-status-info-surface text-status-info",
            )}
          >
            {isAgent ? "⚙" : initialsOf(card.actorName)}
          </div>
          <p className="min-w-0 flex-1 text-xs leading-snug text-text-secondary">
            <strong className="font-semibold text-text-primary">{card.actorName}</strong>{" "}
            {card.action}
          </p>
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              isAgent ? "bg-[var(--agent-accent)]" : "bg-primary",
            )}
          />
          <span className="shrink-0 text-[11px] whitespace-nowrap text-text-subtle">
            {formatRelativeTime(card.createdAt, nowMs)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={ariaHidden ? -1 : undefined}
            aria-label="Dismiss notification"
            className="text-text-subtle hover:text-text-primary"
            onClick={handleDismiss}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>

        {/* Recessed object preview well */}
        <div
          data-testid="live-notification-well"
          onClick={handleOpen}
          className="cursor-pointer rounded-lg border border-border bg-surface-inset px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-surface-interactive-hover"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded border border-border bg-status-neutral-surface px-1.5 py-0.5 font-mono text-[10.5px] font-semibold leading-none text-text-secondary">
              {card.displayId ?? card.subjectLabel}
            </span>
            {isAgent && (
              <span className="rounded bg-[var(--agent-accent-surface)] px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--agent-accent)]">
                Agent handoff
              </span>
            )}
            {card.priority && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-medium leading-none",
                  priorityPillClasses(card.priority),
                )}
              >
                {humanizeValue(card.priority)}
              </span>
            )}
            {card.status && (
              <span className="rounded bg-status-info-surface px-1.5 py-0.5 text-[11px] font-medium leading-none text-status-info">
                {humanizeValue(card.status)}
              </span>
            )}
          </div>
          <p className="break-words text-[13.5px] font-semibold leading-snug text-text-primary">
            {card.title}
          </p>
          {card.commentSnippet && (
            <blockquote className="mt-1.5 line-clamp-2 border-l-2 border-border-strong pl-2 text-xs leading-relaxed text-text-secondary">
              “{card.commentSnippet}”
            </blockquote>
          )}
        </div>

        {/* Action footer row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              tabIndex={ariaHidden ? -1 : undefined}
              data-testid="live-notification-open"
              className="h-7 rounded-md border-primary/30 bg-primary/10 px-2.5 text-xs font-semibold text-primary hover:border-primary hover:bg-primary hover:text-primary-foreground dark:border-primary/35 dark:bg-primary/15 dark:hover:bg-primary dark:hover:text-primary-foreground"
              onClick={handleOpen}
            >
              <span>
                {panelType !== null
                  ? "Open in panel"
                  : `Open ${card.subjectLabel.toLowerCase()}`}
              </span>
              <span aria-hidden="true">↗</span>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              tabIndex={ariaHidden ? -1 : undefined}
              data-testid="live-notification-mark-read"
              className="h-7 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-surface-inset hover:text-text-primary"
              onClick={handleMarkRead}
            >
              Mark read
            </Button>
          </div>
          <span className="shrink-0 text-[11px] text-text-subtle">
            {card.kind === "ASSIGNED" ? "Auto-following" : "Comment thread"}
          </span>
        </div>
      </div>

      {/* 10s hover-paused countdown hairline bar */}
      <div className="h-0.5 w-full overflow-hidden">
        <div
          data-testid="live-notification-countdown"
          data-paused={isPaused ? "true" : "false"}
          className={cn(
            "h-full w-full origin-left",
            isAgent ? "bg-[var(--agent-accent)]" : "bg-primary/60",
          )}
          style={{
            animation: `live-notification-countdown ${CARD_AUTO_DISMISS_MS}ms linear forwards`,
            animationPlayState: isPaused ? "paused" : "running",
          }}
        />
      </div>
    </article>
  )
}
