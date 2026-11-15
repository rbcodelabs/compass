"use client"

import { useCallback, useMemo, useState } from "react"
import { CheckCircle2, Circle, GitFork, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AgentBoardCardPendingDecision } from "@/lib/agent-board"
import { cn } from "@/lib/utils"

type DecisionDraft = {
  selected: string[]
  otherOpen: boolean
  otherText: string
}

const EMPTY_DECISION_DRAFT: DecisionDraft = {
  selected: [],
  otherOpen: false,
  otherText: "",
}

/**
 * Module-scoped draft store keyed by `${conversationId}:d:${decisionId}` so background SSE
 * patches, column moves, or view switches never lose a half-selected or half-typed decision.
 */
const decisionDraftStore = new Map<string, DecisionDraft>()

function draftKeyFor(conversationId: string, decisionId: string): string {
  return `${conversationId}:d:${decisionId}`
}

function composeDecisionAnswer(decision: AgentBoardCardPendingDecision, draft: DecisionDraft): string {
  const parts = [...draft.selected]
  const custom = draft.otherText.trim()
  if ((decision.options.length === 0 || draft.otherOpen) && custom) {
    parts.push(custom)
  }
  return parts.join(", ").trim()
}

export type DecisionAnswerSubmissionResult = {
  itemId: string
  conversationId: string
  targetConversationId: string
  formattedMessage: string
  runId: string | null
}

type DecisionCardProps = {
  conversationId: string
  decisions: readonly AgentBoardCardPendingDecision[]
  compact?: boolean
  onAnswered?: (result: DecisionAnswerSubmissionResult) => void
  onDismissed?: (decisionId: string) => void
  className?: string
}

/**
 * Renders orchestrator `DECISION` prompts (`threads_post_decision`) inline on `Needs you`
 * Board cards and above the `AgentChat` composer. Submitting routes
 * `Decision <header> [<decisionId>]: <answer>` as a user turn to `sourceConversationId`
 * (the orchestrator thread), never the subject thread.
 */
export function DecisionCard({
  conversationId,
  decisions,
  compact = false,
  onAnswered,
  onDismissed,
  className,
}: DecisionCardProps) {
  const [, bumpDraftVersion] = useState(0)
  const [optimisticallyResolvedIds, setOptimisticallyResolvedIds] = useState<Record<string, true>>({})
  const [submitting, setSubmitting] = useState(false)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pendingDecisions = useMemo(
    () => decisions.filter((d) => d.status === "PENDING" && !optimisticallyResolvedIds[d.id]),
    [decisions, optimisticallyResolvedIds],
  )

  const visibleDecisions = useMemo(
    () => (compact ? pendingDecisions.slice(0, 1) : pendingDecisions),
    [compact, pendingDecisions],
  )

  const readDraft = useCallback(
    (decisionId: string): DecisionDraft => {
      return decisionDraftStore.get(draftKeyFor(conversationId, decisionId)) ?? EMPTY_DECISION_DRAFT
    },
    [conversationId],
  )

  const updateDraft = useCallback(
    (decisionId: string, updater: (prev: DecisionDraft) => DecisionDraft) => {
      setError(null)
      const key = draftKeyFor(conversationId, decisionId)
      const next = updater(decisionDraftStore.get(key) ?? EMPTY_DECISION_DRAFT)
      decisionDraftStore.set(key, next)
      bumpDraftVersion((v) => v + 1)
    },
    [conversationId],
  )

  const toggleOption = useCallback(
    (decision: AgentBoardCardPendingDecision, label: string) => {
      updateDraft(decision.id, (prev) => {
        if (decision.multiSelect) {
          const exists = prev.selected.includes(label)
          return {
            ...prev,
            selected: exists ? prev.selected.filter((item) => item !== label) : [...prev.selected, label],
          }
        }
        return {
          ...prev,
          selected: prev.selected[0] === label ? [] : [label],
          otherOpen: false,
        }
      })
    },
    [updateDraft],
  )

  const toggleOther = useCallback(
    (decision: AgentBoardCardPendingDecision) => {
      updateDraft(decision.id, (prev) => ({
        ...prev,
        selected: decision.multiSelect ? prev.selected : [],
        otherOpen: !prev.otherOpen,
      }))
    },
    [updateDraft],
  )

  const canSubmit =
    !submitting &&
    visibleDecisions.length > 0 &&
    visibleDecisions.every((d) => composeDecisionAnswer(d, readDraft(d.id)).length > 0)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      let lastResult: DecisionAnswerSubmissionResult | null = null
      for (const decision of visibleDecisions) {
        const answerText = composeDecisionAnswer(decision, readDraft(decision.id))
        const response = await fetch(`/api/agent/conversations/${conversationId}/supervision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "answer_decision",
            itemId: decision.id,
            answerText,
          }),
        })
        const body = (await response.json().catch(() => ({}))) as Partial<DecisionAnswerSubmissionResult> & {
          error?: string
        }
        if (!response.ok) {
          throw new Error(body.error ?? `Could not submit decision (HTTP ${response.status}).`)
        }
        decisionDraftStore.delete(draftKeyFor(conversationId, decision.id))
        setOptimisticallyResolvedIds((prev) => ({ ...prev, [decision.id]: true }))
        lastResult = {
          itemId: body.itemId ?? decision.id,
          conversationId: body.conversationId ?? conversationId,
          targetConversationId: body.targetConversationId ?? decision.sourceConversationId ?? conversationId,
          formattedMessage: body.formattedMessage ?? `Decision [${decision.id}]: ${answerText}`,
          runId: body.runId ?? null,
        }
      }
      if (lastResult) onAnswered?.(lastResult)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit decision.")
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, conversationId, onAnswered, readDraft, visibleDecisions])

  const handleDismiss = useCallback(
    async (decisionId: string) => {
      if (submitting || dismissingId) return
      setDismissingId(decisionId)
      setError(null)
      try {
        const response = await fetch(`/api/agent/conversations/${conversationId}/supervision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "dismiss_decision",
            itemId: decisionId,
          }),
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok) {
          throw new Error(body.error ?? `Could not dismiss decision (HTTP ${response.status}).`)
        }
        decisionDraftStore.delete(draftKeyFor(conversationId, decisionId))
        setOptimisticallyResolvedIds((prev) => ({ ...prev, [decisionId]: true }))
        onDismissed?.(decisionId)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not dismiss decision.")
      } finally {
        setDismissingId(null)
      }
    },
    [conversationId, dismissingId, onDismissed, submitting],
  )

  if (visibleDecisions.length === 0) return null

  return (
    <div
      data-testid={compact ? "board-card-decision-prompt" : "chat-decision-prompt"}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "relative z-10 rounded-xl border border-status-warning/35 bg-surface-inset/90 text-left shadow-xs",
        compact ? "p-2.5" : "p-3.5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-status-warning">
          <GitFork aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Orchestrator decision</span>
        </span>
        {pendingDecisions.length > 1 && (
          <span className="rounded-full bg-surface-card px-2 py-0.5 text-[10px] font-medium tabular-nums text-text-subtle">
            {compact ? `1 of ${pendingDecisions.length}` : `${pendingDecisions.length} decisions`}
          </span>
        )}
      </div>

      <div className={cn("mt-2 flex flex-col", compact ? "gap-2.5" : "gap-3.5")}>
        {visibleDecisions.map((decision) => {
          const draft = readDraft(decision.id)
          const hasPresets = decision.options.length > 0
          const showFreeText = !hasPresets || (decision.allowOther !== false && draft.otherOpen)

          return (
            <div key={decision.id} data-decision-id={decision.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {decision.header && (
                    <span className="rounded-md border border-border-default bg-surface-card px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-text-secondary uppercase">
                      {decision.header}
                    </span>
                  )}
                  {decision.multiSelect && hasPresets && (
                    <span className="text-[10px] text-text-subtle">Select all that apply</span>
                  )}
                </div>
                <button
                  type="button"
                  data-testid="decision-card-dismiss"
                  disabled={submitting || dismissingId === decision.id}
                  onClick={() => void handleDismiss(decision.id)}
                  aria-label="Dismiss decision"
                  title="Dismiss decision"
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-text-subtle hover:bg-surface-card hover:text-text-primary disabled:opacity-50"
                >
                  <X aria-hidden="true" className="size-3" />
                  <span>Dismiss</span>
                </button>
              </div>

              <p className={cn("font-medium text-text-primary", compact ? "text-xs leading-4" : "text-sm leading-5")}>
                {decision.question}
              </p>

              {hasPresets && (
                <div className={cn("mt-0.5 flex flex-col", compact ? "gap-1" : "gap-1.5")}>
                  {decision.options.map((opt) => {
                    const selected = draft.selected.includes(opt.label)
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        aria-pressed={selected}
                        disabled={submitting}
                        onClick={() => toggleOption(decision, opt.label)}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                          compact ? "px-2 py-1.5 text-xs" : "px-2.5 py-2 text-xs",
                          selected
                            ? "border-border-focus bg-surface-card text-text-primary shadow-2xs"
                            : "border-border-default bg-surface-card/70 text-text-secondary hover:border-border-strong hover:bg-surface-card hover:text-text-primary",
                        )}
                      >
                        {selected ? (
                          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-info" />
                        ) : (
                          <Circle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-text-disabled" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-text-primary">{opt.label}</span>
                          {opt.description && !compact && (
                            <span className="mt-0.5 block text-[11px] leading-4 text-text-subtle">
                              {opt.description}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}

                  {decision.allowOther !== false && (
                    <button
                      type="button"
                      aria-pressed={draft.otherOpen}
                      disabled={submitting}
                      onClick={() => toggleOther(decision)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        compact ? "px-2 py-1.5" : "px-2.5 py-1.5",
                        draft.otherOpen
                          ? "border-border-focus bg-surface-card text-text-primary"
                          : "border-border-default bg-surface-card/50 text-text-subtle hover:border-border-strong hover:text-text-primary",
                      )}
                    >
                      {draft.otherOpen ? (
                        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-status-info" />
                      ) : (
                        <Circle aria-hidden="true" className="size-3.5 shrink-0 text-text-disabled" />
                      )}
                      <span className="font-medium">Other…</span>
                    </button>
                  )}
                </div>
              )}

              {showFreeText && (
                <input
                  type="text"
                  value={draft.otherText}
                  disabled={submitting}
                  onChange={(e) =>
                    updateDraft(decision.id, (prev) => ({
                      ...prev,
                      otherText: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) {
                      e.preventDefault()
                      void handleSubmit()
                    }
                  }}
                  aria-label={hasPresets ? `Custom decision for ${decision.question}` : decision.question}
                  placeholder={hasPresets ? "Type a custom decision…" : "Type your decision…"}
                  className={cn(
                    "mt-0.5 w-full rounded-lg border border-border-default bg-surface-card px-2.5 text-xs text-text-primary placeholder:text-text-subtle focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                    compact ? "h-7" : "h-8",
                  )}
                />
              )}
            </div>
          )
        })}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-status-danger">
          {error}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="decision-card-submit"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className={cn(compact && "h-7 px-2.5 text-xs")}
        >
          {submitting ? (
            <>
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Sending…
            </>
          ) : visibleDecisions.length > 1 ? (
            "Submit decisions"
          ) : (
            "Submit decision"
          )}
        </Button>
      </div>
    </div>
  )
}
