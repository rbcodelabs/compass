"use client"

/**
 * The Doc comment composer: a mention-aware editor plus, once someone is
 * mentioned, a "Create task" row (on by default) for the first mention.
 *
 *  - Several mentions: the first is the assignee, the rest are watchers; the
 *    author can promote a different one.
 *  - A first mention outside the workspace cannot be assigned: no task is
 *    created and the author chooses "Mention only" (or, for admins later,
 *    "Invite as viewer").
 *  - Assigning an agent that has no task in this doc yet asks for a scope
 *    confirmation before the comment is posted.
 */
import { useMemo, useState } from "react"
import { Link2, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { MentionEditor, type MentionOption, type MentionOptions } from "@/components/docs/mention-editor"
import { mentionRoles, suggestTaskTitle, uniqueMentions, type MentionRef } from "@/lib/comment-mentions"
import { cn } from "@/lib/utils"
import type { TaskPriority } from "@/lib/types"

export type ComposerResult = { ok: true } | { ok: false; error: string; message: string }

export interface ComposerPayload {
  body: string
  task: { title: string; dueDate: string | null; priority: TaskPriority } | null
  assignee: { kind: "user" | "agent"; id: string } | null
  agentScopeConfirmed: boolean
}

interface DocCommentComposerProps {
  options: MentionOptions
  /** Agents that already hold a task from a comment in this doc: no scope confirmation needed. */
  confirmedAgentIds: string[]
  docTitle: string
  anchorText?: string | null
  placeholder?: string
  ariaLabel?: string
  idleLabel: string
  /** Replies pop the picker upward and skip the passage quote. */
  compact?: boolean
  autoFocus?: boolean
  onSubmit: (payload: ComposerPayload) => Promise<ComposerResult>
  onCancel?: () => void
}

const PRIORITIES: Array<{ value: TaskPriority; label: string }> = [
  { value: "URGENT", label: "Urgent" },
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
]

const ERROR_COPY: Record<string, string> = {
  FORBIDDEN: "You do not have permission to comment or create tasks in this workspace.",
  ASSIGNEE_NOT_IN_WORKSPACE: "That person is not in this workspace, so a task cannot be assigned to them.",
  NO_ASSIGNEE: "Mention someone to assign the task to.",
  EMPTY_TITLE: "Give the task a title.",
  INVALID_PRIORITY: "Choose a priority from the list.",
  INVALID_DUE_DATE: "That due date is not a real date.",
  TASK_FAILED: "The task could not be created, so the comment was not posted.",
}

function chipClass(kind: "user" | "agent", outside: boolean) {
  return cn("mention-chip", kind === "agent" && "mention-chip-agent", outside && "mention-chip-outside")
}

export function DocCommentComposer({
  options, confirmedAgentIds, docTitle, anchorText, placeholder = "Add a comment…", ariaLabel = "Comment",
  idleLabel, compact, autoFocus, onSubmit, onCancel,
}: DocCommentComposerProps) {
  const [body, setBody] = useState("")
  const [taskOn, setTaskOn] = useState(true)
  const [title, setTitle] = useState("")
  const [titleTouched, setTitleTouched] = useState(false)
  const [due, setDue] = useState("")
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM")
  const [promoted, setPromoted] = useState<{ kind: "user" | "agent"; id: string } | null>(null)
  // Remembered per assignee so choosing "Mention only" for one person does not stick to the next.
  const [mentionOnlyFor, setMentionOnlyFor] = useState<string | null>(null)
  // The assignee the scope step was opened for. The step only shows while that is still the assignee,
  // so deleting or swapping the chip behind it brings the normal buttons straight back.
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorKey, setEditorKey] = useState(0)

  const known = useMemo(() => {
    const map = new Map<string, MentionOption>()
    for (const option of [...options.people, ...options.agents, ...options.outside]) map.set(`${option.kind}:${option.id}`, option)
    return map
  }, [options])

  const mentions = useMemo(() => uniqueMentions(body), [body])
  const roles = useMemo(() => mentionRoles(body, promoted), [body, promoted])
  const assignee = roles.assignee
  const assigneeOption = assignee ? known.get(`${assignee.kind}:${assignee.id}`) : undefined
  const assignable = Boolean(assigneeOption && !assigneeOption.outsideWorkspace)
  const outsideAssignee = Boolean(assignee && !assignable)
  const name = (ref: MentionRef) => known.get(`${ref.kind}:${ref.id}`)?.name ?? ref.label

  const effectiveTitle = titleTouched ? title : suggestTaskTitle(body, anchorText)
  const assigneeKey = assignee ? assignee.kind + ":" + assignee.id : null
  const mentionOnly = assigneeKey !== null && mentionOnlyFor === assigneeKey
  const willCreateTask = assignable && taskOn && !mentionOnly
  const label = willCreateTask ? "Comment & create task" : idleLabel
  const needsScopeConfirm = willCreateTask && assignee?.kind === "agent" && !confirmedAgentIds.includes(assignee.id)
  const confirmingAgent = needsScopeConfirm && confirmingFor !== null && confirmingFor === assigneeKey

  async function post(agentScopeConfirmed: boolean) {
    if (busy || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSubmit({
        body,
        task: willCreateTask ? { title: effectiveTitle.trim(), dueDate: due || null, priority } : null,
        assignee: assignee ? { kind: assignee.kind, id: assignee.id } : null,
        agentScopeConfirmed,
      })
      if (!result.ok) {
        setError(ERROR_COPY[result.error] ?? result.message)
        setConfirmingFor(null)
        return
      }
      // Reset for the next comment: remount the editor, clear task fields.
      setEditorKey(key => key + 1)
      setBody(""); setTitle(""); setTitleTouched(false); setDue(""); setPriority("MEDIUM")
      setPromoted(null); setMentionOnlyFor(null); setTaskOn(true); setConfirmingFor(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post the comment.")
    } finally {
      setBusy(false)
    }
  }

  function submit() {
    if (needsScopeConfirm) { setConfirmingFor(assigneeKey); return }
    void post(false)
  }

  return (
    <div data-testid="doc-comment-composer" className="flex min-h-0 flex-col gap-2">
      {/* Everything that can grow lives in the scroll region; the action row below it never scrolls away. */}
      <div className="-mx-0.5 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-0.5" data-testid="composer-scroll">
      {anchorText && !compact && (
        <p className="truncate border-l-[3px] border-status-warning pl-2 text-[11px] text-text-subtle" title={anchorText}>
          Commenting on: “{anchorText}”
        </p>
      )}
      <MentionEditor
        key={editorKey}
        options={options}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={value => { setBody(value); setError(null); setConfirmingFor(null) }}
        onSubmitShortcut={submit}
        onEscape={onCancel}
        testId="doc-comment-editor"
      />

      {mentions.length > 0 && !confirmingAgent && (
        <div className="space-y-2 rounded-lg border border-dashed border-border-default bg-status-info-surface/30 p-2.5" data-testid="comment-task-box">
          {outsideAssignee && assignee ? (
            <div className="rounded-lg bg-status-warning-surface p-2.5 text-sm text-status-warning" data-testid="outside-workspace-alert">
              <p><b>{name(assignee)} isn’t in this workspace.</b> A task can’t be assigned to them.</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled title="Viewer invitations are not available yet. Ask a workspace admin to add them." data-testid="invite-as-viewer">
                  Invite as viewer
                </Button>
                <Button type="button" size="sm" variant={mentionOnly ? "default" : "outline"} onClick={() => setMentionOnlyFor(assigneeKey)} data-testid="mention-only">
                  {mentionOnly ? <><Check className="size-3.5" /> Mention only</> : "Mention only"}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-2.5">
                <Switch
                  size="default"
                  checked={taskOn}
                  onCheckedChange={setTaskOn}
                  aria-label="Create task"
                  data-testid="create-task-toggle"
                  className="mt-0.5"
                />
                <span className="min-w-0 text-sm leading-tight">
                  <b className="block break-words text-text-primary [overflow-wrap:anywhere]">Assign as task to @{assignee ? name(assignee) : ""}</b>
                  <small className="text-xs text-text-subtle">Uncheck to send a plain mention (notification only)</small>
                </span>
              </label>
              {taskOn && (
                <div className="space-y-2" data-testid="task-fields">
                  <label className="grid gap-0.5 text-xs text-text-subtle">
                    Title
                    <Input
                      aria-label="Task title"
                      value={effectiveTitle}
                      maxLength={255}
                      onChange={event => { setTitle(event.target.value); setTitleTouched(true) }}
                      className="h-8 bg-surface-panel text-sm text-text-primary"
                    />
                  </label>
                  <div className="flex gap-2">
                    <label className="grid flex-1 gap-0.5 text-xs text-text-subtle">
                      Due
                      <Input aria-label="Due date" type="date" value={due} onChange={event => setDue(event.target.value)} className="h-8 bg-surface-panel text-sm text-text-primary" />
                    </label>
                    <label className="grid flex-1 gap-0.5 text-xs text-text-subtle">
                      Priority
                      <select
                        aria-label="Priority"
                        value={priority}
                        onChange={event => setPriority(event.target.value as TaskPriority)}
                        className="h-8 rounded-lg border border-input bg-surface-panel px-2 text-sm text-text-primary"
                      >
                        {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-text-subtle">
                    <Link2 className="size-3.5" aria-hidden /> Links back to this passage in <u>{docTitle || "this doc"}</u>
                  </p>
                </div>
              )}
            </>
          )}

          {mentions.length > 1 && (
            <div className="space-y-1 text-xs" data-testid="mention-roles">
              {mentions.map(ref => {
                const option = known.get(`${ref.kind}:${ref.id}`)
                const isAssignee = assignee?.kind === ref.kind && assignee.id === ref.id
                const canPromote = option && !option.outsideWorkspace
                return (
                  <div key={`${ref.kind}:${ref.id}`} className="flex items-center gap-2">
                    <span className={chipClass(ref.kind, Boolean(option?.outsideWorkspace))}>@{name(ref)}</span>
                    <span className={cn("rounded px-1.5 py-px text-[10px] font-bold uppercase", isAssignee ? "bg-status-info text-text-inverse" : "bg-status-neutral-surface text-status-neutral")}>
                      {isAssignee ? "Assignee" : "Watcher"}
                    </span>
                    {!isAssignee && canPromote && (
                      <button type="button" className="text-status-info hover:underline" onClick={() => { setPromoted({ kind: ref.kind, id: ref.id }) }}>
                        Make assignee
                      </button>
                    )}
                  </div>
                )
              })}
              <p className="text-text-subtle">Watchers are notified and follow the task.</p>
            </div>
          )}
        </div>
      )}

      {confirmingAgent && assignee && (
        <div className="space-y-2 rounded-lg border border-border-default bg-surface-card p-2.5 text-sm" data-testid="agent-scope-confirm">
          <p className="flex items-center gap-1.5">
            <span aria-hidden className="flex size-[18px] items-center justify-center rounded-full bg-agent-accent text-[10px] text-text-inverse">{"⚙"}</span>
            <b>{name(assignee)}</b> will receive:
          </p>
          <ul className="space-y-1 text-[13px]">
            <li className="flex gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-status-success" aria-hidden /> A task in its queue, naming this doc and the highlighted passage</li>
            <li className="flex gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-status-success" aria-hidden /> This doc, its comment thread and linked items, read through its workspace access</li>
            {known.get("agent:" + assignee.id)?.access === "WRITE" ? (
              <li className="flex gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-status-success" aria-hidden /> Its Write grant lets it reply in the thread and change content in this workspace</li>
            ) : (
              <li className="flex gap-1.5"><X className="mt-0.5 size-3.5 shrink-0 text-status-danger" aria-hidden /> Its grant is read-only: it cannot change content in this workspace</li>
            )}
          </ul>
          <p className="text-xs text-text-subtle">Nothing runs on its own: the agent picks the task up from its queue.</p>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-status-danger" data-testid="composer-error">{error}</p>}
      </div>

      {confirmingAgent && (
        <div className="flex shrink-0 justify-end gap-2" data-testid="composer-actions">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingFor(null)}>Cancel</Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void post(true)} data-testid="confirm-agent-assign">Assign to agent</Button>
        </div>
      )}

      {!confirmingAgent && (
        <div className="flex shrink-0 justify-end gap-1.5" data-testid="composer-actions">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          )}
          <Button type="button" size="sm" disabled={busy || body.trim().length === 0 || (willCreateTask && !effectiveTitle.trim())} onClick={submit}>
            {label}
          </Button>
        </div>
      )}
    </div>
  )
}
