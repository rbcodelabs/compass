import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ResearchSubmitButton } from "@/components/research/research-submit-button"
import { EXTERNAL_PROVIDERS, EXTERNAL_PROVIDER_LABELS } from "@/lib/research-external"

export function ExternalStudyForm({ action }: { action: (data: FormData) => void | Promise<void> }) {
  return <form action={action} className="max-w-3xl space-y-5 rounded-xl border bg-surface-panel p-5">
    <p className="text-sm text-text-muted">
      Use this for research run outside Compass (for example UserTesting, Maze, or a call you ran yourself). Compass does not
      interview anyone for this study and never creates participant links. You add each session by pasting its transcript or
      notes, and everything you add is labelled as imported, member-reported research.
    </p>
    <div className="space-y-2">
      <Label htmlFor="external-study-name">Study name</Label>
      <Input id="external-study-name" name="name" required maxLength={255} />
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-study-goal">Research goal</Label>
      <Textarea id="external-study-goal" name="goal" required maxLength={5000} rows={3} />
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-study-provider">Where was it run?</Label>
      <select id="external-study-provider" name="externalProvider" required defaultValue="" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
        <option value="" disabled>Choose a provider</option>
        {EXTERNAL_PROVIDERS.map((provider) => <option key={provider} value={provider}>{EXTERNAL_PROVIDER_LABELS[provider]}</option>)}
      </select>
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-study-url">Link to the study (optional)</Label>
      <Input id="external-study-url" name="externalUrl" type="url" maxLength={2000} placeholder="https://" />
    </div>
    <ResearchSubmitButton pendingLabel="Creating…">Create external study</ResearchSubmitButton>
  </form>
}
