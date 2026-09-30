"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createTrackedDecisionAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { RESERVED_OPTION_LABELS, TRACKED_OPTION_LIMITS, TRACKED_QUESTION_LIMITS, type TrackedSubjectType } from "@/lib/tracked-decision-types"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export type DecisionSubjectOption = { type: TrackedSubjectType; id: string; title: string }
type OptionDraft = { key: number; label: string; description: string }
type QuestionDraft = { key: number; header: string; question: string; options: OptionDraft[] }

/** Client-side mirror of the server's option-label rules (see lib/tracked-decisions.ts). Returns an error message or null. */
function optionLabelError(labels: string[]): string | null {
  const seen = new Set<string>()
  for (const label of labels) {
    const key = label.trim().toLowerCase()
    if (RESERVED_OPTION_LABELS.has(key)) return `"${label.trim()}" is reserved — Request changes and Reject are always offered. Choose a different label.`
    if (seen.has(key)) return "Option labels must be unique — two options are both called \"" + label.trim() + "\"."
    seen.add(key)
  }
  return null
}

export function NewDecisionForm({ workspaceId, orgSlug, workspaceSlug, subjects, initial, revise }: {
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  subjects: DecisionSubjectOption[]
  initial?: Partial<Pick<DecisionSubjectOption, "type" | "id">> & { question?: string; context?: string; options?: Array<{ label: string; description?: string | null }>; questions?: Array<{ header?: string | null; question: string; options: Array<{ label: string; description?: string | null }> }> }
  revise?: { requestId: string; expectedDecisionId: string; reason: string }
}) {
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const nextOptionKey = useRef(initial?.options?.length ?? 0)
  const [optionDrafts, setOptionDrafts] = useState<OptionDraft[]>(() => (initial?.options ?? []).map((option, index) => ({ key: index, label: option.label, description: option.description ?? "" })))
  const nextQuestionKey = useRef(initial?.questions?.length ?? 0)
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDraft[]>(() => (initial?.questions ?? []).map((item, index) => ({ key: index, header: item.header ?? "", question: item.question, options: item.options.map((option, optionIndex) => ({ key: optionIndex, label: option.label, description: option.description ?? "" })) })))
  const nextQuestionOptionKey = useRef(1000)
  const [type, setType] = useState<TrackedSubjectType>(initial?.type ?? "WORKSPACE")
  const [subjectId, setSubjectId] = useState(initial?.id ?? workspaceId)
  const [question, setQuestion] = useState(initial?.question ?? "")
  const [context, setContext] = useState(initial?.context ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const available = useMemo(() => subjects.filter((subject) => subject.type === type), [subjects, type])

  function changeType(next: TrackedSubjectType) {
    setType(next)
    setSubjectId(subjects.find((subject) => subject.type === next)?.id ?? "")
  }

  const { min: minOptions, max: maxOptions, labelMax, descriptionMax } = TRACKED_OPTION_LIMITS
  function addOption() {
    // The first click creates the minimum viable pair, so "using options" is
    // never a one-row state the user has to notice and fix.
    const count = optionDrafts.length === 0 ? minOptions : 1
    setOptionDrafts((drafts) => [...drafts, ...Array.from({ length: count }, () => ({ key: nextOptionKey.current++, label: "", description: "" }))].slice(0, maxOptions))
  }
  function updateOption(key: number, patch: Partial<Pick<OptionDraft, "label" | "description">>) {
    setOptionDrafts((drafts) => drafts.map((draft) => draft.key === key ? { ...draft, ...patch } : draft))
  }
  function removeOption(key: number) {
    setOptionDrafts((drafts) => drafts.filter((draft) => draft.key !== key))
  }

  const { min: minQuestions, max: maxQuestions, headerMax, questionMax } = TRACKED_QUESTION_LIMITS
  const usingQuestions = questionDrafts.length > 0
  const usingOptions = optionDrafts.length > 0
  function addQuestion() {
    setQuestionDrafts((drafts) => [...drafts, { key: nextQuestionKey.current++, header: "", question: "", options: Array.from({ length: minOptions }, () => ({ key: nextQuestionOptionKey.current++, label: "", description: "" })) }].slice(0, maxQuestions))
  }
  function updateQuestion(key: number, patch: Partial<Pick<QuestionDraft, "header" | "question">>) {
    setQuestionDrafts((drafts) => drafts.map((draft) => draft.key === key ? { ...draft, ...patch } : draft))
  }
  function removeQuestion(key: number) {
    setQuestionDrafts((drafts) => drafts.filter((draft) => draft.key !== key))
  }
  function addQuestionOption(questionKey: number) {
    setQuestionDrafts((drafts) => drafts.map((draft) => draft.key === questionKey && draft.options.length < maxOptions ? { ...draft, options: [...draft.options, { key: nextQuestionOptionKey.current++, label: "", description: "" }] } : draft))
  }
  function updateQuestionOption(questionKey: number, optionKey: number, patch: Partial<Pick<OptionDraft, "label" | "description">>) {
    setQuestionDrafts((drafts) => drafts.map((draft) => draft.key === questionKey ? { ...draft, options: draft.options.map((option) => option.key === optionKey ? { ...option, ...patch } : option) } : draft))
  }
  function removeQuestionOption(questionKey: number, optionKey: number) {
    setQuestionDrafts((drafts) => drafts.map((draft) => draft.key === questionKey ? { ...draft, options: draft.options.filter((option) => option.key !== optionKey) } : draft))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    // Questions and single options are mutually exclusive; the form disables one
    // editor while the other has content, so this only guards a revise prefill.
    if (usingQuestions && usingOptions) { setError("Use either answer options or questions, not both."); return }
    const questions: Array<{ header?: string; question: string; options: Array<{ label: string; description?: string }> }> = []
    for (const [index, draft] of questionDrafts.entries()) {
      const n = index + 1
      // A fully untouched question is dropped, like blank option rows, so it
      // cannot block submitting a plain decision.
      if (!draft.header.trim() && !draft.question.trim() && draft.options.every((option) => !option.label.trim() && !option.description.trim())) continue
      if (!draft.question.trim()) { setError(`Question ${n} needs its question text.`); return }
      const filledOptions = draft.options.filter((option) => option.label.trim() || option.description.trim())
      if (filledOptions.some((option) => !option.label.trim())) { setError(`Give every option in question ${n} a label.`); return }
      if (filledOptions.length < minOptions) { setError(`Question ${n} needs at least ${minOptions} options.`); return }
      const labelProblem = optionLabelError(filledOptions.map((option) => option.label))
      if (labelProblem) { setError(`Question ${n}: ${labelProblem}`); return }
      questions.push({ ...(draft.header.trim() ? { header: draft.header.trim() } : {}), question: draft.question.trim(), options: filledOptions.map((option) => ({ label: option.label.trim(), ...(option.description.trim() ? { description: option.description.trim() } : {}) })) })
    }
    // Fully blank rows are dropped so an untouched pair doesn't block submitting
    // a plain Approve / Request changes / Reject decision.
    const filled = optionDrafts.filter((draft) => draft.label.trim() || draft.description.trim())
    if (filled.some((draft) => !draft.label.trim())) { setError("Give every option a label."); return }
    if (filled.length === 1) { setError(`Add at least ${minOptions} options, or remove them to use Approve / Request changes / Reject.`); return }
    // Mirror the server rules here: production builds mask server-action error
    // messages behind a generic React error, so the reviewer-facing wording has
    // to come from the client.
    const labelProblem = optionLabelError(filled.map((draft) => draft.label))
    if (labelProblem) { setError(labelProblem); return }
    const options = filled.map((draft) => ({ label: draft.label.trim(), ...(draft.description.trim() ? { description: draft.description.trim() } : {}) }))
    startTransition(async () => {
      try {
        // Always arrays (possibly empty): on a revision, [] means "back to the
        // standard three", while omitting them would inherit the prior choices.
        const result = await createTrackedDecisionAction({ workspaceId, subjectType: type, subjectId, question, context, options, questions, idempotencyKey, revise })
        router.push(`/${orgSlug}/${workspaceSlug}/reviews/${result.requestId}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not request the decision.")
      }
    })
  }

  return <form onSubmit={submit} className="max-w-2xl space-y-5 rounded-xl border bg-card p-6">
    <label className="block space-y-1 text-sm"><span className="font-medium">Link to</span>
      <select className="w-full rounded-md border bg-background px-3 py-2" value={type} onChange={(event) => changeType(event.target.value as TrackedSubjectType)} disabled={Boolean(revise)}>
        <option value="WORKSPACE">Workspace</option><option value="OPPORTUNITY">Opportunity</option><option value="SOLUTION">Solution</option><option value="ROADMAP_ITEM">Roadmap Item</option><option value="DOC">Doc</option><option value="EXPERIMENT">Experiment</option><option value="FEEDBACK">Feedback</option>
      </select>
    </label>
    <label className="block space-y-1 text-sm"><span className="font-medium">Item</span>
      <select className="w-full rounded-md border bg-background px-3 py-2" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} disabled={Boolean(revise)} required>
        {available.map((subject) => <option key={subject.id} value={subject.id}>{subject.title}</option>)}
      </select>
    </label>
    <label className="block space-y-1 text-sm"><span className="font-medium">Decision question</span><Input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={255} placeholder="What needs to be decided?" required /></label>
    <label className="block space-y-1 text-sm"><span className="font-medium">Context</span><Textarea value={context} onChange={(event) => setContext(event.target.value)} maxLength={20000} rows={7} placeholder="Give the reviewer enough context to decide. Markdown supported." required /><span className="text-xs text-muted-foreground">Markdown supported.</span></label>
    <fieldset className="min-w-0 space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Answer options <span className="font-normal text-muted-foreground">(optional)</span></legend>
      {usingQuestions && <p className="text-xs text-muted-foreground">Answer options are unavailable while the request has questions. Remove the questions below to use them.</p>}
      <p className="text-xs text-muted-foreground">Ask a multiple-choice question: add {minOptions}–{maxOptions} options and the reviewer picks one. Request changes and Reject are always offered too. Leave empty for Approve / Request changes / Reject.</p>
      {optionDrafts.length > 0 && <ol className="space-y-3">
        {optionDrafts.map((draft, index) => <li key={draft.key} className="min-w-0 space-y-2 rounded-md border bg-background p-3">
          <div className="flex min-w-0 items-center gap-2">
            <Input aria-label={`Option ${index + 1} label`} value={draft.label} onChange={(event) => updateOption(draft.key, { label: event.target.value })} maxLength={labelMax} placeholder={`Option ${index + 1}`} />
            <button type="button" onClick={() => removeOption(draft.key)} aria-label={`Remove option ${index + 1}`} className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">Remove</button>
          </div>
          <Textarea aria-label={`Option ${index + 1} description`} value={draft.description} onChange={(event) => updateOption(draft.key, { description: event.target.value })} maxLength={descriptionMax} rows={2} placeholder="Optional description — what does choosing this mean?" />
        </li>)}
      </ol>}
      <button type="button" onClick={addOption} disabled={usingQuestions || optionDrafts.length >= maxOptions} className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">{optionDrafts.length === 0 ? "Add answer options" : "Add option"}</button>
      {optionDrafts.length >= maxOptions && <span className="ml-2 text-xs text-muted-foreground">Maximum of {maxOptions} options.</span>}
    </fieldset>
    <fieldset className="min-w-0 space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Questions <span className="font-normal text-muted-foreground">(optional)</span></legend>
      <p className="text-xs text-muted-foreground">Ask {minQuestions}–{maxQuestions} questions in one request, each with its own {minOptions}–{maxOptions} options. The reviewer answers every question and submits once; Request changes and Reject still apply to the whole request. Use either this or answer options above, not both.</p>
      {usingOptions && <p className="text-xs text-muted-foreground">Questions are unavailable while answer options are set. Remove the answer options above to use them.</p>}
      {usingQuestions && <ol className="space-y-4">
        {questionDrafts.map((draft, index) => <li key={draft.key} className="min-w-0 space-y-3 rounded-md border bg-background p-3">
          <div className="flex min-w-0 items-center gap-2">
            <Input aria-label={`Question ${index + 1} header`} value={draft.header} onChange={(event) => updateQuestion(draft.key, { header: event.target.value })} maxLength={headerMax} placeholder="Short label (optional)" className="max-w-[10rem] shrink-0" />
            <button type="button" onClick={() => removeQuestion(draft.key)} aria-label={`Remove question ${index + 1}`} className="ml-auto shrink-0 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">Remove question</button>
          </div>
          <Input aria-label={`Question ${index + 1} text`} value={draft.question} onChange={(event) => updateQuestion(draft.key, { question: event.target.value })} maxLength={questionMax} placeholder={`Question ${index + 1}`} />
          <ol className="space-y-2">
            {draft.options.map((option, optionIndex) => <li key={option.key} className="min-w-0 space-y-2 rounded-md border p-2">
              <div className="flex min-w-0 items-center gap-2">
                <Input aria-label={`Question ${index + 1} option ${optionIndex + 1} label`} value={option.label} onChange={(event) => updateQuestionOption(draft.key, option.key, { label: event.target.value })} maxLength={labelMax} placeholder={`Option ${optionIndex + 1}`} />
                <button type="button" onClick={() => removeQuestionOption(draft.key, option.key)} aria-label={`Remove question ${index + 1} option ${optionIndex + 1}`} className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">Remove</button>
              </div>
              <Textarea aria-label={`Question ${index + 1} option ${optionIndex + 1} description`} value={option.description} onChange={(event) => updateQuestionOption(draft.key, option.key, { description: event.target.value })} maxLength={descriptionMax} rows={2} placeholder="Optional description" />
            </li>)}
          </ol>
          <button type="button" onClick={() => addQuestionOption(draft.key)} disabled={draft.options.length >= maxOptions} className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Add option to question {index + 1}</button>
        </li>)}
      </ol>}
      <button type="button" onClick={addQuestion} disabled={usingOptions || questionDrafts.length >= maxQuestions} className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">{usingQuestions ? "Add question" : "Add questions"}</button>
      {questionDrafts.length >= maxQuestions && <span className="ml-2 text-xs text-muted-foreground">Maximum of {maxQuestions} questions.</span>}
    </fieldset>
    {revise && <p className="rounded-md bg-muted p-3 text-sm"><strong>Revised request:</strong> {revise.reason}</p>}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <button type="submit" disabled={pending || !subjectId} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Requesting…" : "Request decision"}</button>
  </form>
}
