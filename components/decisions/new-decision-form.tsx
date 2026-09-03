"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createTrackedDecisionAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import type { TrackedSubjectType } from "@/lib/tracked-decisions"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export type DecisionSubjectOption = { type: TrackedSubjectType; id: string; title: string }

export function NewDecisionForm({ workspaceId, orgSlug, workspaceSlug, subjects, initial, revise }: {
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  subjects: DecisionSubjectOption[]
  initial?: Partial<Pick<DecisionSubjectOption, "type" | "id">> & { question?: string; context?: string }
  revise?: { requestId: string; expectedDecisionId: string; reason: string }
}) {
  const [idempotencyKey] = useState(() => crypto.randomUUID())
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

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        const result = await createTrackedDecisionAction({ workspaceId, subjectType: type, subjectId, question, context, idempotencyKey, revise })
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
    <label className="block space-y-1 text-sm"><span className="font-medium">Context</span><Textarea value={context} onChange={(event) => setContext(event.target.value)} maxLength={20000} rows={7} placeholder="Give the reviewer enough context to decide." required /></label>
    {revise && <p className="rounded-md bg-muted p-3 text-sm"><strong>Revised request:</strong> {revise.reason}</p>}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <button type="submit" disabled={pending || !subjectId} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Requesting…" : "Request decision"}</button>
  </form>
}
