"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitFork,
  HelpCircle,
  Loader2,
  Send,
  Sparkles,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/agent/markdown"
import {
  cardNeedsYou,
  classifyBoardCard,
  type AgentBoardCard,
} from "@/lib/agent-board"
import {
  clearBoardCardHighlights,
  highlightBoardCard,
} from "@/lib/orchestrator/thread-links"
import type {
  OrchestratorDockMessage,
  OrchestratorDockState,
} from "@/lib/agent-supervision-actions"
import { cn } from "@/lib/utils"

const PEEK_DURATION_MS = 8_000
const DOCK_POLL_ACTIVE_MS = 2_500
const DOCK_POLL_IDLE_MS = 10_000

type SuggestionChip = {
  id: string
  label: string
  prompt: string
}

/** Module-scoped draft so switching between Board and Chat never clears a half-typed dock prompt. */
const dockDraftByWorkspace = new Map<string, string>()

type OrchestratorDockProps = {
  workspaceId: string
  basePath: string
  cards: readonly AgentBoardCard[]
  onOpenConversation: (conversationId: string) => void
  onMutated?: () => void
}

/**
 * Floating `OrchestratorDock` on the Agent Board:
 *   - Collapsed `Ask the orchestrator…` pill (`Cmd+J` / `Ctrl+J`)
 *   - Animated orb ring spinning while any workspace thread is `Working`
 *   - `Needs you` count badge + 8s Unread Peek banner on new orchestrator replies
 *   - Slide-up Reply Sheet with Attention Tray, contextual suggestion chips, and
 *     `<Markdown>` transcript rendering interactive `[[thread:<id>|Title]]` chips
 */
export function OrchestratorDock({
  workspaceId,
  basePath,
  cards,
  onOpenConversation,
  onMutated,
}: OrchestratorDockProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [attentionExpanded, setAttentionExpanded] = useState(true)
  const [input, setInput] = useState(() => dockDraftByWorkspace.get(workspaceId) ?? "")
  const [dockState, setDockState] = useState<OrchestratorDockState | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [peekMessage, setPeekMessage] = useState<OrchestratorDockMessage | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const sheetInputRef = useRef<HTMLTextAreaElement>(null)
  const lastSeenAssistantIdRef = useRef<string | null>(null)
  const seededUnreadRef = useRef(false)

  const updateInput = useCallback(
    (value: string) => {
      setInput(value)
      if (value) dockDraftByWorkspace.set(workspaceId, value)
      else dockDraftByWorkspace.delete(workspaceId)
    },
    [workspaceId],
  )

  const needsYouCards = useMemo(() => cards.filter((c) => cardNeedsYou(c)), [cards])
  const failedCards = useMemo(
    () => cards.filter((c) => classifyBoardCard(c) === "failed"),
    [cards],
  )
  const workingCount = useMemo(
    () =>
      cards.filter((c) => c.runStatus === "QUEUED" || c.runStatus === "RUNNING").length +
      (dockState?.runStatus === "QUEUED" || dockState?.runStatus === "RUNNING" ? 1 : 0),
    [cards, dockState?.runStatus],
  )
  const anyWorking = workingCount > 0
  const orchestratorWorking =
    dockState?.runStatus === "QUEUED" || dockState?.runStatus === "RUNNING"

  const suggestions = useMemo<SuggestionChip[]>(() => {
    const list: SuggestionChip[] = []
    if (needsYouCards.length > 0) {
      list.push({
        id: "needs-me",
        label: `What needs me? (${needsYouCards.length})`,
        prompt: "What needs me right now? List the threads waiting on me and what each one needs.",
      })
    }
    if (failedCards.length > 0) {
      list.push({
        id: "triage-failed",
        label: `Triage failed (${failedCards.length})`,
        prompt: "Triage the failed threads: for each, say why it failed and what you recommend.",
      })
    }
    list.push(
      {
        id: "summarise-today",
        label: "Summarise today",
        prompt: "Summarise today's activity across my threads.",
      },
      {
        id: "what-shipped",
        label: "What shipped?",
        prompt: "What shipped recently? Link the threads and PRs.",
      },
    )
    return list
  }, [failedCards.length, needsYouCards.length])

  const fetchDockState = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/agent/orchestrator/dock?workspaceId=${encodeURIComponent(workspaceId)}`,
      )
      if (!res.ok) return
      const data = (await res.json()) as OrchestratorDockState
      setDockState(data)

      const latestAssistant = [...data.messages].reverse().find((m) => m.role === "assistant")
      if (!seededUnreadRef.current) {
        seededUnreadRef.current = true
        lastSeenAssistantIdRef.current = latestAssistant?.id ?? null
        return
      }
      if (latestAssistant && latestAssistant.id !== lastSeenAssistantIdRef.current) {
        lastSeenAssistantIdRef.current = latestAssistant.id
        if (!sheetOpen) {
          setPeekMessage(latestAssistant)
        }
      }
    } catch {
      /* next poll reconciles */
    }
  }, [sheetOpen, workspaceId])

  useEffect(() => {
    void fetchDockState()
    const intervalMs = sheetOpen || orchestratorWorking ? DOCK_POLL_ACTIVE_MS : DOCK_POLL_IDLE_MS
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void fetchDockState()
    }, intervalMs)
    return () => clearInterval(timer)
  }, [fetchDockState, orchestratorWorking, sheetOpen])

  // Auto-dismiss the 8s Unread Peek banner.
  useEffect(() => {
    if (!peekMessage) return
    const timer = setTimeout(() => setPeekMessage(null), PEEK_DURATION_MS)
    return () => clearTimeout(timer)
  }, [peekMessage])

  // Global Cmd+J / Ctrl+J shortcut to toggle/focus the OrchestratorDock.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault()
        setSheetOpen((prev) => {
          const next = !prev
          if (next) {
            setPeekMessage(null)
            setTimeout(() => sheetInputRef.current?.focus(), 0)
          }
          return next
        })
      } else if (e.key === "Escape" && sheetOpen) {
        clearBoardCardHighlights()
        setSheetOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [sheetOpen])

  const sendMessage = useCallback(
    async (rawText: string) => {
      const clean = rawText.trim()
      if (!clean || sending) return
      setSending(true)
      setError(null)
      setSheetOpen(true)
      setPeekMessage(null)
      updateInput("")

      const optimisticUserMsg: OrchestratorDockMessage = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        content: clean,
        createdAt: new Date().toISOString(),
      }
      setDockState((prev) => ({
        orchestratorId: prev?.orchestratorId ?? null,
        conversationId: prev?.conversationId ?? null,
        title: prev?.title ?? "Workspace Orchestrator",
        enabled: true,
        runStatus: "QUEUED",
        currentActivity: "Starting turn…",
        messages: [...(prev?.messages ?? []), optimisticUserMsg],
      }))

      try {
        const res = await fetch("/api/agent/orchestrator/dock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            message: clean,
          }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          conversationId?: string
          error?: string
        }
        if (!res.ok) {
          throw new Error(body.error ?? `Could not message orchestrator (HTTP ${res.status}).`)
        }
        await fetchDockState()
        onMutated?.()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not message orchestrator.")
      } finally {
        setSending(false)
      }
    },
    [fetchDockState, onMutated, sending, updateInput, workspaceId],
  )

  return (
    <div
      data-testid="orchestrator-dock"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col items-center px-3 sm:px-6 md:bottom-5"
    >
      {/* 8s Unread Peek Banner */}
      {!sheetOpen && peekMessage && (
        <div
          data-testid="orchestrator-dock-peek"
          role="status"
          onClick={() => {
            setPeekMessage(null)
            setSheetOpen(true)
          }}
          className="pointer-events-auto mb-2.5 flex w-full max-w-lg cursor-pointer items-start justify-between gap-2.5 rounded-2xl border border-status-info/40 bg-surface-card/95 px-3.5 py-2.5 shadow-[var(--shadow-panel)] backdrop-blur-md transition hover:border-status-info"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-status-info">
              <Bot aria-hidden="true" className="size-3.5 shrink-0" />
              <span>Workspace Orchestrator</span>
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-text-primary">
              <Markdown>{peekMessage.content}</Markdown>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss preview"
            onClick={(e) => {
              e.stopPropagation()
              setPeekMessage(null)
            }}
            className="rounded-md p-1 text-text-subtle hover:bg-surface-inset hover:text-text-primary"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}

      {/* Slide-up Reply Sheet */}
      {sheetOpen && (
        <section
          data-testid="orchestrator-dock-sheet"
          aria-label="Workspace Orchestrator"
          className="pointer-events-auto mb-2.5 flex max-h-[min(34rem,75vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-card shadow-[var(--shadow-panel)]"
        >
          {/* Sheet header */}
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border-default bg-surface-panel px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full border",
                  anyWorking
                    ? "border-status-info/50 bg-status-info-surface text-status-info"
                    : "border-border-default bg-surface-inset text-text-secondary",
                )}
              >
                {orchestratorWorking ? (
                  <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
                ) : (
                  <Bot aria-hidden="true" className="size-3.5" />
                )}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="truncate text-xs font-semibold text-text-primary">
                    {dockState?.title || "Workspace Orchestrator"}
                  </h2>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      orchestratorWorking
                        ? "bg-status-info-surface text-status-info"
                        : "bg-surface-inset text-text-subtle",
                    )}
                  >
                    {orchestratorWorking ? dockState?.currentActivity || "Working…" : "Ready"}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {dockState?.conversationId && (
                <a
                  href={`${basePath}/agent?c=${encodeURIComponent(dockState.conversationId)}`}
                  data-testid="orchestrator-dock-open-thread"
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                    e.preventDefault()
                    clearBoardCardHighlights()
                    setSheetOpen(false)
                    onOpenConversation(dockState.conversationId!)
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-inset hover:text-text-primary"
                >
                  <span>Open chat</span>
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              )}
              <button
                type="button"
                data-testid="orchestrator-dock-close"
                aria-label="Close orchestrator sheet"
                onClick={() => {
                  clearBoardCardHighlights()
                  setSheetOpen(false)
                }}
                className="rounded-md p-1 text-text-subtle hover:bg-surface-inset hover:text-text-primary"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          </header>

          {/* Attention Tray (Needs you items across the workspace) */}
          {needsYouCards.length > 0 && (
            <div
              data-testid="orchestrator-dock-attention-tray"
              className="shrink-0 border-b border-border-default bg-surface-inset/70 px-3.5 py-2"
            >
              <button
                type="button"
                aria-expanded={attentionExpanded}
                onClick={() => setAttentionExpanded((prev) => !prev)}
                className="flex w-full items-center justify-between gap-2 text-left text-[11px] font-semibold text-status-warning"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-status-warning" aria-hidden="true" />
                  <span>Needs you ({needsYouCards.length})</span>
                </span>
                {attentionExpanded ? (
                  <ChevronUp aria-hidden="true" className="size-3.5 text-text-subtle" />
                ) : (
                  <ChevronDown aria-hidden="true" className="size-3.5 text-text-subtle" />
                )}
              </button>

              {attentionExpanded && (
                <div className="mt-1.5 flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
                  {needsYouCards.map((card) => {
                    const hasReply = Boolean(card.proposedReply?.text)
                    const hasDecision = (card.pendingDecisions?.length ?? 0) > 0
                    const kindLabel = hasDecision
                      ? "Decision"
                      : hasReply
                        ? "Proposed reply"
                        : "Question"
                    return (
                      <button
                        key={card.id}
                        type="button"
                        data-testid={`attention-tray-item-${card.id}`}
                        onMouseEnter={() => highlightBoardCard(card.id, { scroll: true })}
                        onMouseLeave={() => clearBoardCardHighlights()}
                        onFocus={() => highlightBoardCard(card.id, { scroll: true })}
                        onBlur={() => clearBoardCardHighlights()}
                        onClick={() => {
                          clearBoardCardHighlights()
                          if (!highlightBoardCard(card.id, { scroll: true })) {
                            setSheetOpen(false)
                            onOpenConversation(card.id)
                          }
                        }}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border-default bg-surface-card px-2.5 py-1.5 text-left text-xs transition-colors hover:border-border-strong"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {hasDecision ? (
                            <GitFork aria-hidden="true" className="size-3.5 shrink-0 text-status-warning" />
                          ) : hasReply ? (
                            <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-status-info" />
                          ) : (
                            <HelpCircle aria-hidden="true" className="size-3.5 shrink-0 text-status-warning" />
                          )}
                          <span className="truncate font-medium text-text-primary">
                            {card.title || "Untitled chat"}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-md bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                          {kindLabel}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Transcript */}
          <div
            data-testid="orchestrator-dock-transcript"
            className="flex min-h-[10rem] flex-1 flex-col gap-2.5 overflow-y-auto p-3.5"
          >
            {!dockState || dockState.messages.length === 0 ? (
              <div className="my-auto flex flex-col items-center justify-center py-6 text-center">
                <Bot aria-hidden="true" className="size-6 text-text-subtle" />
                <p className="mt-2 text-xs font-medium text-text-primary">
                  Ask your Workspace Orchestrator anything
                </p>
                <p className="mt-0.5 max-w-xs text-[11px] text-text-subtle">
                  Coordinate threads across squads, stage proposed replies, or triage blockers.
                </p>
              </div>
            ) : (
              dockState.messages.map((msg) => (
                <div
                  key={msg.id}
                  data-testid={`orchestrator-dock-msg-${msg.role}`}
                  className={cn(
                    "max-w-[92%] rounded-xl px-3 py-2 text-xs",
                    msg.role === "user"
                      ? "ml-auto bg-surface-inset font-medium text-text-primary"
                      : "mr-auto border border-border-default bg-surface-panel text-text-primary",
                  )}
                >
                  {msg.role === "assistant" ? (
                    <Markdown>{msg.content}</Markdown>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Contextual Suggestion Chips */}
          <div
            data-testid="orchestrator-dock-suggestions"
            className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border-default/70 bg-surface-panel/60 px-3.5 py-2"
          >
            {suggestions.map((chip) => (
              <button
                key={chip.id}
                type="button"
                data-testid={`orchestrator-suggestion-${chip.id}`}
                disabled={sending}
                onClick={() => void sendMessage(chip.prompt)}
                className="rounded-full border border-border-default bg-surface-card px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:opacity-50"
              >
                {chip.label}
              </button>
            ))}
          </div>

          {error && (
            <p role="alert" className="px-3.5 pt-1.5 text-xs text-status-danger">
              <AlertCircle aria-hidden="true" className="mr-1 inline size-3.5" />
              {error}
            </p>
          )}

          {/* Sheet Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void sendMessage(input)
            }}
            className="flex shrink-0 items-end gap-2 border-t border-border-default bg-surface-card p-3"
          >
            <textarea
              ref={sheetInputRef}
              rows={2}
              value={input}
              disabled={sending}
              onChange={(e) => updateInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void sendMessage(input)
                }
              }}
              aria-label="Ask the orchestrator"
              placeholder="Ask the orchestrator… (Enter to send)"
              className="min-h-[2.25rem] max-h-24 flex-1 resize-none rounded-xl border border-border-default bg-surface-inset px-3 py-1.5 text-xs leading-relaxed text-text-primary placeholder:text-text-subtle focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            <Button
              type="submit"
              size="sm"
              data-testid="orchestrator-dock-send"
              disabled={sending || !input.trim()}
              className="h-8 gap-1.5 px-3 text-xs"
            >
              {sending ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <Send aria-hidden="true" className="size-3.5" />
              )}
              Send
            </Button>
          </form>
        </section>
      )}

      {/* Floating Pill / Orb */}
      <form
        data-testid="orchestrator-dock-pill"
        onSubmit={(e) => {
          e.preventDefault()
          if (input.trim()) {
            void sendMessage(input)
          } else {
            setSheetOpen((prev) => !prev)
          }
        }}
        className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-full border border-border-strong bg-surface-card/95 py-1.5 pr-2 pl-2.5 shadow-[var(--shadow-panel)] backdrop-blur-md transition focus-within:border-border-focus focus-within:ring-2 focus-within:ring-ring/30"
      >
        <button
          type="button"
          data-testid="orchestrator-dock-orb"
          data-working={anyWorking ? "true" : "false"}
          aria-label={sheetOpen ? "Collapse orchestrator dock" : "Open orchestrator dock"}
          aria-expanded={sheetOpen}
          onClick={() => {
            setPeekMessage(null)
            setSheetOpen((prev) => !prev)
          }}
          className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border-default bg-surface-inset text-text-primary transition hover:border-border-strong"
        >
          {anyWorking && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full border-2 border-transparent border-t-status-info border-r-status-info motion-safe:animate-spin"
            />
          )}
          <Bot aria-hidden="true" className={cn("size-3.5", anyWorking && "text-status-info")} />
          {needsYouCards.length > 0 && (
            <span
              data-testid="orchestrator-dock-badge"
              className="absolute -top-1 -right-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-status-warning px-1 text-[10px] font-bold leading-4 text-surface-card tabular-nums"
            >
              {needsYouCards.length > 9 ? "9+" : needsYouCards.length}
            </span>
          )}
        </button>

        <input
          ref={inputRef}
          type="text"
          data-testid="orchestrator-dock-input"
          value={input}
          onFocus={() => setPeekMessage(null)}
          onChange={(e) => updateInput(e.target.value)}
          aria-label="Ask the orchestrator"
          placeholder="Ask the orchestrator…"
          className="min-w-0 flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-subtle focus:outline-none"
        />

        <kbd className="hidden rounded border border-border-default bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] text-text-subtle sm:inline-block">
          ⌘J
        </kbd>

        <button
          type="submit"
          aria-label={input.trim() ? "Send to orchestrator" : "Toggle orchestrator sheet"}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-inset text-text-secondary transition hover:bg-surface-interactive hover:text-text-primary"
        >
          <Send aria-hidden="true" className="size-3" />
        </button>
      </form>
    </div>
  )
}
