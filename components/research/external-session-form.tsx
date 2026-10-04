"use client"

import { useActionState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ResearchSubmitButton } from "@/components/research/research-submit-button"
import { MAX_EXTERNAL_NOTES_CHARS, MAX_EXTERNAL_TRANSCRIPT_CHARS, type ExternalFormState } from "@/lib/research-external-constants"

/**
 * Manual session import for an EXTERNAL study. `idempotencyKey` is minted by the
 * server page per render so a double-submit or retry cannot create a second session.
 */
export function ExternalSessionForm({ action, idempotencyKey }: { action: (previous: ExternalFormState, data: FormData) => Promise<ExternalFormState>; idempotencyKey: string }) {
  const [state, formAction] = useActionState(action, {} as ExternalFormState)
  const values = state.values ?? {}
  return <form action={formAction} className="max-w-3xl rounded-xl border bg-surface-panel p-5">
    <div key={state.attempt ?? 0} className="space-y-4">
    <h2 className="font-semibold">Add a session</h2>
    <p className="text-sm text-text-muted">
      Paste what you have from the external tool. Sessions are saved as completed and labelled as imported, member-reported
      research; Compass cannot verify that the provider produced them.
    </p>
    {state.error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.error}</p>}
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="external-session-name">Participant name (optional)</Label>
        <Input id="external-session-name" name="participantName" defaultValue={values.participantName} maxLength={255} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="external-session-email">Participant email (optional)</Label>
        <Input id="external-session-email" name="participantEmail" defaultValue={values.participantEmail} type="email" maxLength={255} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="external-session-date">Session date (optional)</Label>
        <Input id="external-session-date" name="sessionDate" defaultValue={values.sessionDate} type="date" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="external-session-url">Link to the session (optional)</Label>
        <Input id="external-session-url" name="externalUrl" defaultValue={values.externalUrl} type="url" maxLength={2000} placeholder="https://" />
      </div>
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-session-transcript">Transcript</Label>
      <Textarea id="external-session-transcript" name="transcript" defaultValue={values.transcript} rows={10} maxLength={MAX_EXTERNAL_TRANSCRIPT_CHARS} />
      <p className="text-xs text-text-muted">
        Start lines with “Interviewer:” or “Participant:” to mark who is speaking. Unlabelled text is treated as the participant.
        A transcript is needed for AI analysis and for promoting findings to evidence.
      </p>
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-session-notes">Notes or summary</Label>
      <Textarea id="external-session-notes" name="notes" defaultValue={values.notes} rows={5} maxLength={MAX_EXTERNAL_NOTES_CHARS} />
      <p className="text-xs text-text-muted">Add a transcript, notes, or both. Notes are stored with the session but cannot be cited as evidence.</p>
    </div>
    <ResearchSubmitButton pendingLabel="Saving…">Save session</ResearchSubmitButton>
    </div>
  </form>
}
