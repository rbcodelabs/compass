"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { Textarea } from "@/components/ui/textarea"

export function DecisionActions({ workspaceId, revisionId, fingerprint, options }: {
  workspaceId: string
  revisionId: string
  fingerprint: string
  options: Array<{ id: string; label: string; outcomeClass: string }>
}) {
  const [rationale, setRationale] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function decide(option: (typeof options)[number]) {
    if ((option.outcomeClass === "REJECT" || option.outcomeClass === "REQUEST_CHANGES") && !rationale.trim()) {
      setError("Add a rationale before rejecting or requesting changes.")
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        await decideReviewAction({ workspaceId, revisionId, fingerprint, optionId: option.id, rationale })
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not record the decision.")
      }
    })
  }

  return <div className="space-y-3">
    <label className="block space-y-1 text-sm">
      <span className="font-medium">Rationale <span className="text-muted-foreground">(required for changes or rejection)</span></span>
      <Textarea aria-label="Rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain the reasoning behind this decision…" />
    </label>
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <div className="flex flex-wrap gap-3">
      {options.map((option) => <button key={option.id} disabled={pending} onClick={() => decide(option)} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50" type="button">{option.label}</button>)}
    </div>
  </div>
}
