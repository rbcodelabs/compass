"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { Textarea } from "@/components/ui/textarea"
import { isChoiceActionKey, isSubmitAnswersActionKey, type TrackedDecisionPacketQuestion } from "@/lib/tracked-decision-types"
import { cn } from "@/lib/utils"

type DecisionOption = { id: string; label: string; outcomeClass: string; actionKey?: string; description?: string | null }

const BUTTON = "rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
const CARD = "flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 text-sm transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
const PUSHBACK = "rounded-md border border-transparent px-3 py-1.5 text-sm text-muted-foreground underline-offset-4 hover:bg-muted hover:text-foreground hover:underline disabled:opacity-50"

export function DecisionActions({ workspaceId, revisionId, fingerprint, options, questions = [] }: {
  workspaceId: string
  revisionId: string
  fingerprint: string
  options: DecisionOption[]
  /** Questions on a multi-question request; empty for option-less and single-options requests. */
  questions?: TrackedDecisionPacketQuestion[]
}) {
  const [rationale, setRationale] = useState("")
  // Chosen option label per question index (multi-question requests).
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
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
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        await decideReviewAction({ workspaceId, revisionId, fingerprint, optionId: option.id, rationale, ...(submitted ? { answers: submitted } : {}) })
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not record the decision.")
      }
    })
  }

  const rationaleField = <label className="block space-y-1 text-sm">
    <span className="font-medium">Rationale <span className="text-muted-foreground">{hasChoices ? "(optional for your choice; required for changes or rejection)" : "(required for changes or rejection)"}</span></span>
    <Textarea aria-label="Rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder={hasChoices ? "Add context, or write your own answer if none of the options fit… Markdown supported." : "Explain the reasoning behind this decision… Markdown supported."} />
    <span className="text-xs text-muted-foreground">Markdown supported.</span>
  </label>

  if (isMultiQuestion && submitOption) {
    const answered = questions.every((_, index) => answers[index] !== undefined)
    const unanswered = questions.filter((_, index) => answers[index] === undefined).length
    const pushbackOptions = options.filter((option) => option.id !== submitOption.id)
    return <div className="min-w-0 space-y-5">
      {questions.map((question, index) => <fieldset key={index} className="min-w-0 space-y-2">
        <legend className="mb-1 min-w-0 max-w-full text-sm font-medium">
          {question.header && <span className="mr-2 inline-block max-w-full break-words rounded-full border px-2 py-0.5 align-middle text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{question.header}</span>}
          <span className="break-words [overflow-wrap:anywhere]">{question.question}</span>
        </legend>
        <div className="grid min-w-0 gap-2">
          {question.options.map((option) => <label key={option.label} className={cn(CARD, pending && "cursor-not-allowed opacity-60")}>
            <input type="radio" name={`${groupName}-q${index}`} value={option.label} checked={answers[index] === option.label} disabled={pending} onChange={() => { setAnswers((current) => ({ ...current, [index]: option.label })); setError(null) }} className="mt-1 size-4 shrink-0 accent-primary" />
            <span className="min-w-0 flex-1">
              <span className="block whitespace-normal break-words [overflow-wrap:anywhere] font-medium">{option.label}</span>
              {option.description && <span className="mt-0.5 block whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">{option.description}</span>}
            </span>
          </label>)}
        </div>
      </fieldset>)}
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Rationale <span className="text-muted-foreground">(optional when you answer; required for changes or rejection)</span></span>
        <Textarea aria-label="Rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Add context, or explain why none of the options fit… Markdown supported." />
        <span className="text-xs text-muted-foreground">Markdown supported.</span>
      </label>
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending || !answered} onClick={() => decide(submitOption, questions.map((_, index) => ({ questionIndex: index, chosenOption: answers[index] })))} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Recording…" : "Submit answers"}</button>
        {!answered && <span className="text-xs text-muted-foreground">{unanswered === 1 ? "1 question left to answer." : `${unanswered} questions left to answer.`}</span>}
      </div>
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">Push back on the whole request instead (a rationale is required; no answers needed).</p>
        <div className="flex flex-wrap gap-3">
          {pushbackOptions.map((option) => <button key={option.id} disabled={pending} onClick={() => decide(option)} className={PUSHBACK} type="button">{option.label}</button>)}
        </div>
      </div>
    </div>
  }

  if (!hasChoices) {
    return <div className="space-y-3">
      {rationaleField}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      <div className="flex flex-wrap gap-3">
        {options.map((option) => <button key={option.id} disabled={pending} onClick={() => decide(option)} className={BUTTON} type="button">{option.label}</button>)}
      </div>
    </div>
  }

  const selected = choices.find((option) => option.id === selectedId) ?? null
  return <div className="min-w-0 space-y-4">
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-1 text-sm font-medium">Choose an answer</legend>
      <div className="grid min-w-0 gap-2">
        {choices.map((option) => <label
          key={option.id}
          className={cn(
            "flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 text-sm transition-colors hover:bg-muted/50",
            "has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            pending && "cursor-not-allowed opacity-60",
          )}
        >
          <input type="radio" name={groupName} value={option.id} checked={selectedId === option.id} disabled={pending} onChange={() => { setSelectedId(option.id); setError(null) }} className="mt-1 size-4 shrink-0 accent-primary" />
          <span className="min-w-0 flex-1">
            <span className="block whitespace-normal break-words [overflow-wrap:anywhere] font-medium">{option.label}</span>
            {option.description && <span className="mt-0.5 block whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">{option.description}</span>}
          </span>
        </label>)}
      </div>
    </fieldset>
    {rationaleField}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={pending || !selected} onClick={() => selected && decide(selected)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Recording…" : "Confirm choice"}</button>
    </div>
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs text-muted-foreground">None of these fit? Push back instead (a rationale is required).</p>
      <div className="flex flex-wrap gap-3">
        {pushback.map((option) => <button key={option.id} disabled={pending} onClick={() => decide(option)} className="rounded-md border border-transparent px-3 py-1.5 text-sm text-muted-foreground underline-offset-4 hover:bg-muted hover:text-foreground hover:underline disabled:opacity-50" type="button">{option.label}</button>)}
      </div>
    </div>
  </div>
}
