"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createTrackedDecisionAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { RESERVED_OPTION_LABELS, TRACKED_OPTION_LIMITS, type TrackedSubjectType } from "@/lib/tracked-decision-types"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export type DecisionSubjectOption = { type: TrackedSubjectType; id: string; title: string }
type OptionDraft = { key: number; label: string; description: string }

export function NewDecisionForm({ workspaceId, orgSlug, workspaceSlug, subjects, initial, revise }: {
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  subjects: DecisionSubjectOption[]
  initial?: Partial<Pick<DecisionSubjectOption, "type" | "id">> & { question?: string; context?: string; options?: Array<{ label: string; description?: string | null }> }
  revise?: { requestId: string; expectedDecisionId: string; reason: string }
}) {
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const nextOptionKey = useRef(initial?.options?.length ?? 0)
  const [optionDrafts, setOptionDrafts] = useState<OptionDraft[]>(() => (initial?.options ?? []).map((option, index) => ({ key: index, label: option.label, description: option.description ?? "" })))
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

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    // Fully blank rows are dropped so an untouched pair doesn't block submitting
    // a plain Approve / Request changes / Reject decision.
    const filled = optionDrafts.filter((draft) => draft.label.trim() || draft.description.trim())
    if (filled.some((draft) => !draft.label.trim())) { setError("Give every option a label."); return }
    if (filled.length === 1) { setError(`Add at least ${minOptions} options, or remove them to use Approve / Request changes / Reject.`); return }
    // Mirror the server rules here: production builds mask server-action error
    // messages behind a generic React error, so the reviewer-facing wording has
    // to come from the client.
    const seen = new Set<string>()
    for (const draft of filled) {
      const key = draft.label.trim().toLowerCase()
      if (RESERVED_OPTION_LABELS.has(key)) { setError(`"${draft.label.trim()}" is reserved — Request changes and Reject are always offered. Choose a different label.`); return }
      if (seen.has(key)) { setError("Option labels must be unique — two options are both called \"" + draft.label.trim() + "\"."); return }
      seen.add(key)
    }
    const options = filled.map((draft) => ({ label: draft.label.trim(), ...(draft.description.trim() ? { description: draft.description.trim() } : {}) }))
    startTransition(async () => {
      try {
        // Always an array (possibly empty): on a revision, [] means "back to the
        // standard three", while omitting it would inherit the prior options.
        const result = await createTrackedDecisionAction({ workspaceId, subjectType: type, subjectId, question, context, options, idempotencyKey, revise })
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
      <button type="button" onClick={addOption} disabled={optionDrafts.length >= maxOptions} className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">{optionDrafts.length === 0 ? "Add answer options" : "Add option"}</button>
      {optionDrafts.length >= maxOptions && <span className="ml-2 text-xs text-muted-foreground">Maximum of {maxOptions} options.</span>}
    </fieldset>
    {revise && <p className="rounded-md bg-muted p-3 text-sm"><strong>Revised request:</strong> {revise.reason}</p>}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <button type="submit" disabled={pending || !subjectId} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Requesting…" : "Request decision"}</button>
  </form>
}
