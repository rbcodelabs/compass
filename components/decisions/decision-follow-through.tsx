"use client"

/**
 * Direction B's decided-decision surface (opportunity 80cb853b).
 *
 * Shows the work a decision produced, and — when it produced none — offers the
 * two honest ways out: create a follow-up task, or record that no action is
 * needed and why. Leaving it blank is what this feature exists to stop.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createFollowUpTaskAction, closeDecisionNoActionAction } from "@/app/[orgSlug]/[workspaceSlug]/reviews/actions"

export type FollowUpTask = { id: string; title: string; status: string }
export type AssigneeOption = { type: "USER" | "AGENT"; id: string; displayName: string; ownerName?: string }
export type NoAction = { reason: string | null; at: Date } | null

const UNASSIGNED = "__unassigned__"
const key = (option: { type: string; id: string }) => `${option.type}:${option.id}`

export function DecisionFollowThrough({
  workspaceId, requestId, tasksBasePath, tasks, assignees, suggested, draft, noAction, canEdit,
}: {
  workspaceId: string
  requestId: string
  tasksBasePath: string
  tasks: FollowUpTask[]
  assignees: AssigneeOption[]
  suggested: { assignee: { type: "USER" | "AGENT"; id: string }; provenance: string } | null
  draft: { title: string; description: string }
  noAction: NoAction
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [title, setTitle] = useState(draft.title)
  const [description, setDescription] = useState(draft.description)
  const [assignee, setAssignee] = useState(suggested ? key(suggested.assignee) : UNASSIGNED)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  // The suggestion is a default, never a lock — it stays visible as provenance
  // only while the suggested person is still the one selected.
  const showProvenance = suggested !== null && assignee === key(suggested.assignee)

  function submit() {
    if (!title.trim()) { setError("Give the follow-up a title."); return }
    setError(null)
    startTransition(async () => {
      try {
        const [type, id] = assignee === UNASSIGNED ? [null, null] : assignee.split(":")
        await createFollowUpTaskAction({
          workspaceId, requestId, title, description,
          assignee: type && id ? { type: type as "USER" | "AGENT", id } : null,
        })
        setOpen(false)
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not create the follow-up.")
      }
    })
  }

  function close() {
    if (!reason.trim()) { setError("Say why no action is needed."); return }
    setError(null)
    startTransition(async () => {
      try {
        await closeDecisionNoActionAction({ workspaceId, requestId, reason })
        setClosing(false)
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not close the decision.")
      }
    })
  }

  return (
    <section className="space-y-3 rounded-lg border p-4 text-sm" aria-labelledby="follow-through-heading">
      <h2 id="follow-through-heading" className="text-sm font-medium">Follow-through</h2>

      {tasks.length > 0 ? (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-2">
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{task.status.replaceAll("_", " ")}</span>
              <Link href={`${tasksBasePath}/${task.id}`} className="truncate hover:underline underline-offset-2">{task.title}</Link>
            </li>
          ))}
        </ul>
      ) : noAction ? (
        <p className="text-muted-foreground"><strong className="text-foreground">No action needed.</strong> {noAction.reason}</p>
      ) : (
        <p className="text-muted-foreground">This decision has not produced any work yet.</p>
      )}

      {canEdit && !open && !closing && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            <PlusIcon className="size-3.5" />
            Create follow-up
          </Button>
          {tasks.length === 0 && !noAction && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setClosing(true)}>No action needed…</Button>
          )}
        </div>
      )}

      {canEdit && open && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="follow-up-title">Title</Label>
            <Input id="follow-up-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="follow-up-assignee">Assignee</Label>
            <Select value={assignee} onValueChange={(value) => setAssignee(value ?? UNASSIGNED)} disabled={pending}>
              {/* The bare <SelectValue /> renders the raw value, which is fine
                  for selects whose value equals its label (priority, status)
                  but here would show "USER:<uuid>". Base UI's Value accepts a
                  formatter, so map back to the display name. */}
              <SelectTrigger id="follow-up-assignee">
                <SelectValue>
                  {(value: string | null) => value && value !== UNASSIGNED
                    ? assignees.find((option) => key(option) === value)?.displayName ?? "Unassigned"
                    : "Unassigned"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {assignees.map((option) => (
                  <SelectItem key={key(option)} value={key(option)}>
                    {option.displayName}{option.type === "AGENT" ? ` (agent${option.ownerName ? ` · ${option.ownerName}` : ""})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showProvenance && <p className="text-xs text-muted-foreground">{suggested.provenance}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="follow-up-description">Description</Label>
            <Textarea id="follow-up-description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={pending} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={submit} disabled={pending}>{pending ? "Creating…" : "Create follow-up"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null) }} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}

      {canEdit && closing && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="no-action-reason">Why is no action needed?</Label>
            <Textarea id="no-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={close} disabled={pending}>{pending ? "Saving…" : "Record no action needed"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setClosing(false); setError(null) }} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  )
}
