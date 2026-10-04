import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ResearchSubmitButton } from "@/components/research/research-submit-button"
import { MAX_EXTERNAL_NOTES_CHARS, MAX_EXTERNAL_TRANSCRIPT_CHARS } from "@/lib/research-external"

/**
 * Manual session import for an EXTERNAL study. `idempotencyKey` is minted by the
 * server page per render so a double-submit or retry cannot create a second session.
 */
export function ExternalSessionForm({ action, idempotencyKey }: { action: (data: FormData) => void | Promise<void>; idempotencyKey: string }) {
  return <form action={action} className="max-w-3xl space-y-4 rounded-xl border bg-surface-panel p-5">
    <h2 className="font-semibold">Add a session</h2>
    <p className="text-sm text-text-muted">
      Paste what you have from the external tool. Sessions are saved as completed and labelled as imported, member-reported
      research; Compass cannot verify that the provider produced them.
    </p>
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="external-session-name">Participant name (optional)</Label>
        <Input id="external-session-name" name="participantName" maxLength={255} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="external-session-email">Participant email (optional)</Label>
        <Input id="external-session-email" name="participantEmail" type="email" maxLength={255} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="external-session-date">Session date (optional)</Label>
        <Input id="external-session-date" name="sessionDate" type="date" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="external-session-url">Link to the session (optional)</Label>
        <Input id="external-session-url" name="externalUrl" type="url" maxLength={2000} placeholder="https://" />
      </div>
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-session-transcript">Transcript</Label>
      <Textarea id="external-session-transcript" name="transcript" rows={10} maxLength={MAX_EXTERNAL_TRANSCRIPT_CHARS} />
      <p className="text-xs text-text-muted">
        Start lines with “Interviewer:” or “Participant:” to mark who is speaking. Unlabelled text is treated as the participant.
        A transcript is needed for AI analysis and for promoting findings to evidence.
      </p>
    </div>
    <div className="space-y-2">
      <Label htmlFor="external-session-notes">Notes or summary</Label>
      <Textarea id="external-session-notes" name="notes" rows={5} maxLength={MAX_EXTERNAL_NOTES_CHARS} />
      <p className="text-xs text-text-muted">Add a transcript, notes, or both. Notes are stored with the session but cannot be cited as evidence.</p>
    </div>
    <ResearchSubmitButton pendingLabel="Saving…">Save session</ResearchSubmitButton>
  </form>
}
