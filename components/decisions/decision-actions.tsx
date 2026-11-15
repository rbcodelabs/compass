"use client"

import { useId, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DECISION_UPDATED_EVENT, notifyDecisionUpdated } from "@/lib/decision-review-ui"
import { isChoiceActionKey, isSubmitAnswersActionKey, type TrackedDecisionPacketQuestion } from "@/lib/tracked-decision-types"
import { cn } from "@/lib/utils"

type DecisionOption = { id: string; label: string; outcomeClass: string; actionKey?: string; description?: string | null }

export { DECISION_UPDATED_EVENT }

const CARD =
  "flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border-default bg-surface-card p-3 text-sm transition-colors hover:bg-surface-hover has-[:checked]:border-primary has-[:checked]:bg-accent/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"

function outcomeButtonVariant(outcomeClass: string): "default" | "outline" | "ghost" {
  if (outcomeClass === "APPROVE") return "default"
  if (outcomeClass === "REQUEST_CHANGES") return "outline"
  return "ghost"
}

export function DecisionActions({ workspaceId, revisionId, fingerprint, options, questions = [], onDecided }: {
  workspaceId: string
  revisionId: string
  fingerprint: string
  options: DecisionOption[]
  /** Questions on a multi-question request; empty for option-less and single-options requests. */
  questions?: TrackedDecisionPacketQuestion[]
  /** Called once the decision is recorded, for hosts (the sidebar panel) that hold their own copy of the data. */
  onDecided?: () => void
}) {
  const [rationale, setRationale] = useState("")
  // Chosen option label per question index (multi-question requests).
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const rationaleRef = useRef<HTMLTextAreaElement>(null)
  const router = useRouter()
  const groupName = useId()
  const choices = options.filter((option) => isChoiceActionKey(option.actionKey))
  const pushback = options.filter((option) => !isChoiceActionKey(option.actionKey))
  const hasChoices = choices.length > 0

  const submitOption = options.find((option) => isSubmitAnswersActionKey(option.actionKey))
  const isMultiQuestion = questions.length > 0 && Boolean(submitOption)

  function decide(option: DecisionOption, submitted?: Array<{ questionIndex: number; chosenOption: string }>) {
    if ((option.outcomeClass === "REJECT" || option.outcomeClass === "REQUEST_CHANGES") && !rationale.trim()) {
      setError("Add a rationale before rejecting or requesting changes.")
      rationaleRef.current?.focus()
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        await decideReviewAction({ workspaceId, revisionId, fingerprint, optionId: option.id, rationale, ...(submitted ? { answers: submitted } : {}) })
        notifyDecisionUpdated(revisionId)
        router.refresh()
        onDecided?.()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not record the decision.")
      }
    })
  }

  const rationaleField = <label className="block space-y-1.5 text-sm">
    <span className="flex flex-wrap items-baseline justify-between gap-1">
      <span className="text-xs font-medium text-text-primary">
        Rationale{" "}
        <span className="font-normal text-muted-foreground">
          {hasChoices ? "(optional for your choice; required for changes or rejection)" : "(required for changes or rejection)"}
        </span>
      </span>
      <span className="text-[11px] text-muted-foreground">Markdown supported.</span>
    </span>
    <Textarea
      ref={rationaleRef}
      aria-label="Rationale"
      rows={2}
      className="min-h-16 bg-surface-card"
      value={rationale}
      onChange={(event) => {
        setRationale(event.target.value)
        if (error) setError(null)
      }}
      placeholder={hasChoices ? "Add context, or write your own answer if none of the options fit…" : "Optional note for approval, or explain changes / rejection…"}
    />
  </label>

  if (isMultiQuestion && submitOption) {
    const answered = questions.every((_, index) => answers[index] !== undefined)
    const unanswered = questions.filter((_, index) => answers[index] === undefined).length
    const pushbackOptions = options.filter((option) => option.id !== submitOption.id)
    return <div className="min-w-0 space-y-4">
      {questions.map((question, index) => <fieldset key={index} className="min-w-0 space-y-2">
        <legend className="mb-1 min-w-0 max-w-full text-sm font-medium text-text-primary">
          {question.header && <span className="mr-2 inline-block max-w-full break-words rounded-full border border-border-default bg-surface-inset px-2 py-0.5 align-middle text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{question.header}</span>}
          <span className="break-words [overflow-wrap:anywhere]">{question.question}</span>
        </legend>
        <div className="grid min-w-0 gap-2">
          {question.options.map((option) => <label key={option.label} className={cn(CARD, pending && "cursor-not-allowed opacity-60")}>
            <input type="radio" name={`${groupName}-q${index}`} value={option.label} checked={answers[index] === option.label} disabled={pending} onChange={() => { setAnswers((current) => ({ ...current, [index]: option.label })); setError(null) }} className="mt-1 size-4 shrink-0 accent-primary" />
            <span className="min-w-0 flex-1">
              <span className="block whitespace-normal break-words [overflow-wrap:anywhere] font-medium text-text-primary">{option.label}</span>
              {option.description && <span className="mt-0.5 block whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">{option.description}</span>}
            </span>
          </label>)}
        </div>
      </fieldset>)}
      <label className="block space-y-1.5 text-sm">
        <span className="flex flex-wrap items-baseline justify-between gap-1">
          <span className="text-xs font-medium text-text-primary">
            Rationale{" "}
            <span className="font-normal text-muted-foreground">(optional when you answer; required for changes or rejection)</span>
          </span>
          <span className="text-[11px] text-muted-foreground">Markdown supported.</span>
        </span>
        <Textarea
          ref={rationaleRef}
          aria-label="Rationale"
          rows={2}
          className="min-h-16 bg-surface-card"
          value={rationale}
          onChange={(event) => {
            setRationale(event.target.value)
            if (error) setError(null)
          }}
          placeholder="Add context, or explain why none of the options fit…"
        />
      </label>
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={pending || !answered} onClick={() => decide(submitOption, questions.map((_, index) => ({ questionIndex: index, chosenOption: answers[index] })))}>
            {pending ? "Recording…" : "Submit answers"}
          </Button>
          {!answered && <span className="text-xs text-muted-foreground">{unanswered === 1 ? "1 question left to answer." : `${unanswered} questions left to answer.`}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pushbackOptions.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={option.outcomeClass === "REQUEST_CHANGES" ? "outline" : "ghost"}
              className={cn(option.outcomeClass === "REJECT" && "text-muted-foreground hover:bg-status-danger-surface hover:text-status-danger")}
              disabled={pending}
              onClick={() => decide(option)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  }

  if (!hasChoices) {
    return <div className="min-w-0 space-y-3">
      {rationaleField}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
        {options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant={outcomeButtonVariant(option.outcomeClass)}
            className={cn(option.outcomeClass === "REJECT" && "text-muted-foreground hover:bg-status-danger-surface hover:text-status-danger")}
            disabled={pending}
            onClick={() => decide(option)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  }

  const selected = choices.find((option) => option.id === selectedId) ?? null
  return <div className="min-w-0 space-y-4">
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-1 text-sm font-medium text-text-primary">Choose an answer</legend>
      <div className="grid min-w-0 gap-2">
        {choices.map((option) => <label
          key={option.id}
          className={cn(CARD, pending && "cursor-not-allowed opacity-60")}
        >
          <input type="radio" name={groupName} value={option.id} checked={selectedId === option.id} disabled={pending} onChange={() => { setSelectedId(option.id); setError(null) }} className="mt-1 size-4 shrink-0 accent-primary" />
          <span className="min-w-0 flex-1">
            <span className="block whitespace-normal break-words [overflow-wrap:anywhere] font-medium text-text-primary">{option.label}</span>
            {option.description && <span className="mt-0.5 block whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">{option.description}</span>}
          </span>
        </label>)}
      </div>
    </fieldset>
    {rationaleField}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
      <Button type="button" disabled={pending || !selected} onClick={() => selected && decide(selected)}>
        {pending ? "Recording…" : "Confirm choice"}
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        {pushback.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={option.outcomeClass === "REQUEST_CHANGES" ? "outline" : "ghost"}
            className={cn(option.outcomeClass === "REJECT" && "text-muted-foreground hover:bg-status-danger-surface hover:text-status-danger")}
            disabled={pending}
            onClick={() => decide(option)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  </div>
}
