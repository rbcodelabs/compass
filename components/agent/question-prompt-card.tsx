"use client"

import { useCallback, useMemo, useState } from "react"
import { CheckCircle2, Circle, HelpCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AgentBoardCardPendingQuestion } from "@/lib/agent-board"
import { cn } from "@/lib/utils"

export type QuestionAnswerSubmissionResult = {
  itemId: string
  conversationId: string
  delivery: "live_run" | "continuation_queued_on_remaining" | "continuation_run"
  remainingPendingCount: number
  runId: string | null
}

type QuestionDraft = {
  selected: string[]
  otherOpen: boolean
  otherText: string
}

const EMPTY_DRAFT: QuestionDraft = {
  selected: [],
  otherOpen: false,
  otherText: "",
}

function composeAnswerText(question: AgentBoardCardPendingQuestion, draft: QuestionDraft): string {
  const parts = [...draft.selected]
  const custom = draft.otherText.trim()
  if ((question.options.length === 0 || draft.otherOpen) && custom) {
    parts.push(custom)
  }
  return parts.join(", ").trim()
}

type QuestionPromptCardProps = {
  questions: readonly AgentBoardCardPendingQuestion[]
  /** Compact layout for inline Agent Board cards (`Awaiting` column). */
  compact?: boolean
  onAnswered?: (result: QuestionAnswerSubmissionResult) => void
  className?: string
}

/**
 * Interactive human-in-the-loop `AskUserQuestion` card rendered inline on `Awaiting` Board cards
 * and above the `AgentChat` composer.
 *
 * Draft selections and custom text are keyed by `question.id` in local state so background SSE
 * board patches or chat polls never wipe a half-selected or half-typed answer.
 */
export function QuestionPromptCard({
  questions,
  compact = false,
  onAnswered,
  className,
}: QuestionPromptCardProps) {
  const [draftsById, setDraftsById] = useState<Record<string, QuestionDraft>>({})
  const [optimisticallyAnsweredIds, setOptimisticallyAnsweredIds] = useState<Record<string, true>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pendingQuestions = useMemo(
    () => questions.filter((q) => q.status === "PENDING" && !optimisticallyAnsweredIds[q.id]),
    [questions, optimisticallyAnsweredIds],
  )

  const visibleQuestions = useMemo(
    () => (compact ? pendingQuestions.slice(0, 1) : pendingQuestions),
    [compact, pendingQuestions],
  )

  const updateDraft = useCallback((questionId: string, updater: (prev: QuestionDraft) => QuestionDraft) => {
    setError(null)
    setDraftsById((prev) => ({
      ...prev,
      [questionId]: updater(prev[questionId] ?? EMPTY_DRAFT),
    }))
  }, [])

  const toggleOption = useCallback(
    (question: AgentBoardCardPendingQuestion, label: string) => {
      updateDraft(question.id, (prev) => {
        if (question.multiSelect) {
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
    (question: AgentBoardCardPendingQuestion) => {
      updateDraft(question.id, (prev) => ({
        ...prev,
        selected: question.multiSelect ? prev.selected : [],
        otherOpen: !prev.otherOpen,
      }))
    },
    [updateDraft],
  )

  const canSubmit =
    !submitting &&
    visibleQuestions.length > 0 &&
    visibleQuestions.every((q) => composeAnswerText(q, draftsById[q.id] ?? EMPTY_DRAFT).length > 0)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      let lastResult: QuestionAnswerSubmissionResult | null = null
      for (const question of visibleQuestions) {
        const answerText = composeAnswerText(question, draftsById[question.id] ?? EMPTY_DRAFT)
        const response = await fetch(`/api/agent/inbox/${question.id}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answerText }),
        })
        const body = (await response.json().catch(() => ({}))) as Partial<QuestionAnswerSubmissionResult> & {
          error?: string
        }
        if (!response.ok) {
          throw new Error(body.error ?? `Could not submit answer (HTTP ${response.status}).`)
        }
        setOptimisticallyAnsweredIds((prev) => ({ ...prev, [question.id]: true }))
        lastResult = {
          itemId: body.itemId ?? question.id,
          conversationId: body.conversationId ?? question.conversationId ?? "",
          delivery: body.delivery ?? "live_run",
          remainingPendingCount: body.remainingPendingCount ?? 0,
          runId: body.runId ?? null,
        }
      }
      if (lastResult) onAnswered?.(lastResult)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit answer.")
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, draftsById, onAnswered, visibleQuestions])

  if (visibleQuestions.length === 0) return null

  return (
    <div
      data-testid={compact ? "board-card-question-prompt" : "chat-question-prompt"}
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
          <HelpCircle aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Awaiting your input</span>
        </span>
        {pendingQuestions.length > 1 && (
          <span className="rounded-full bg-surface-card px-2 py-0.5 text-[10px] font-medium tabular-nums text-text-subtle">
            {compact ? `1 of ${pendingQuestions.length}` : `${pendingQuestions.length} questions`}
          </span>
        )}
      </div>

      <div className={cn("mt-2 flex flex-col", compact ? "gap-2.5" : "gap-3.5")}>
        {visibleQuestions.map((question) => {
          const draft = draftsById[question.id] ?? EMPTY_DRAFT
          const hasPresets = question.options.length > 0
          const showFreeText = !hasPresets || (question.allowOther !== false && draft.otherOpen)

          return (
            <div key={question.id} data-question-id={question.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {question.header && (
                  <span className="rounded-md border border-border-default bg-surface-card px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-text-secondary uppercase">
                    {question.header}
                  </span>
                )}
                {question.multiSelect && hasPresets && (
                  <span className="text-[10px] text-text-subtle">Select all that apply</span>
                )}
              </div>

              <p className={cn("font-medium text-text-primary", compact ? "text-xs leading-4" : "text-sm leading-5")}>
                {question.question}
              </p>

              {hasPresets && (
                <div className={cn("mt-0.5 flex flex-col", compact ? "gap-1" : "gap-1.5")}>
                  {question.options.map((opt) => {
                    const selected = draft.selected.includes(opt.label)
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        aria-pressed={selected}
                        disabled={submitting}
                        onClick={() => toggleOption(question, opt.label)}
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

                  {question.allowOther !== false && (
                    <button
                      type="button"
                      aria-pressed={draft.otherOpen}
                      disabled={submitting}
                      onClick={() => toggleOther(question)}
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
                    updateDraft(question.id, (prev) => ({
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
                  aria-label={hasPresets ? `Custom answer for ${question.question}` : question.question}
                  placeholder={hasPresets ? "Type a custom answer…" : "Type your answer…"}
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
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className={cn(compact && "h-7 px-2.5 text-xs")}
        >
          {submitting ? (
            <>
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Sending…
            </>
          ) : visibleQuestions.length > 1 ? (
            "Submit answers"
          ) : (
            "Submit answer"
          )}
        </Button>
      </div>
    </div>
  )
}
