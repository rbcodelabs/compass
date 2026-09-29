"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { decideReviewAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"
import { Textarea } from "@/components/ui/textarea"
import { isChoiceActionKey } from "@/lib/tracked-decision-types"
import { cn } from "@/lib/utils"

type DecisionOption = { id: string; label: string; outcomeClass: string; actionKey?: string; description?: string | null }

const BUTTON = "rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"

export function DecisionActions({ workspaceId, revisionId, fingerprint, options }: {
  workspaceId: string
  revisionId: string
  fingerprint: string
  options: DecisionOption[]
}) {
  const [rationale, setRationale] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const groupName = useId()
  const choices = options.filter((option) => isChoiceActionKey(option.actionKey))
  const pushback = options.filter((option) => !isChoiceActionKey(option.actionKey))
  const hasChoices = choices.length > 0

  function decide(option: DecisionOption) {
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

  const rationaleField = <label className="block space-y-1 text-sm">
    <span className="font-medium">Rationale <span className="text-muted-foreground">{hasChoices ? "(optional for your choice; required for changes or rejection)" : "(required for changes or rejection)"}</span></span>
    <Textarea aria-label="Rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder={hasChoices ? "Add context, or write your own answer if none of the options fit… Markdown supported." : "Explain the reasoning behind this decision… Markdown supported."} />
    <span className="text-xs text-muted-foreground">Markdown supported.</span>
  </label>

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
