"use client"

import { useActionState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ResearchSubmitButton } from "@/components/research/research-submit-button"
import { EXTERNAL_PROVIDERS, EXTERNAL_PROVIDER_LABELS, type ExternalFormState } from "@/lib/research-external-constants"

export function ExternalStudyForm({ action }: { action: (previous: ExternalFormState, data: FormData) => Promise<ExternalFormState> }) {
  const [state, formAction] = useActionState(action, {} as ExternalFormState)
  const values = state.values ?? {}
  return <form action={formAction} className="max-w-3xl rounded-xl border bg-surface-panel p-5">
    <div key={state.attempt ?? 0} className="space-y-5">
    <p className="text-sm text-text-muted">
      Use this for research run outside Compass (for example UserTesting, Maze, or a call you ran yourself). Compass does not
      interview anyone for this study and never creates participant links. You add each session by pasting its transcript or
      notes, and everything you add is labelled as imported, member-reported research.
    </p>
    {state.error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.error}</p>}
    <div className="space-y-2">
      <Label htmlFor="external-study-name">Study name</Label>
      <Input id="external-study-name" name="name" required maxLength={255} defaultValue={values.name} />
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-study-goal">Research goal</Label>
      <Textarea id="external-study-goal" name="goal" required maxLength={5000} rows={3} defaultValue={values.goal} />
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-study-provider">Where was it run?</Label>
      <select id="external-study-provider" name="externalProvider" required defaultValue={values.externalProvider ?? ""} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
        <option value="" disabled>Choose a provider</option>
        {EXTERNAL_PROVIDERS.map((provider) => <option key={provider} value={provider}>{EXTERNAL_PROVIDER_LABELS[provider]}</option>)}
      </select>
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-study-url">Link to the study (optional)</Label>
      <Input id="external-study-url" name="externalUrl" type="url" maxLength={2000} placeholder="https://" defaultValue={values.externalUrl} />
    </div>
    <ResearchSubmitButton pendingLabel="Creating…">Create external study</ResearchSubmitButton>
    </div>
  </form>
}
