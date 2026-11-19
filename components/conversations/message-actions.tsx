"use client"

/**
 * The body of a person-authored message in a shared conversation, plus its edit affordance (TASK-195 S1).
 *
 *  - `SharedMessageBody` renders the stored text as markdown with mention chips and GitHub PR chips, the way the old
 *    Discussion did. It goes through `MarkdownContent` (react-markdown, no raw HTML plugin), so markup in a message is
 *    shown as text and never becomes DOM.
 *  - `SharedMessageContent` adds the "Edited" marker and, only when the SERVER said the caller may edit
 *    (`canEdit`), an Edit action that swaps the body for an in-place editor (Save / Cancel; Escape cancels).
 *
 * Copy here is entity-neutral on purpose: the thinking model renames entities per workspace.
 */

import { useCallback, useState, type KeyboardEvent } from "react"

import { MentionEditor, type MentionOptions } from "@/components/docs/mention-editor"
import { MarkdownContent } from "@/components/markdown-content"
import { MentionAwareLink, mentionLookup } from "@/components/comments/mention-chips"
import { Button } from "@/components/ui/button"
import { mentionsAsMarkdownLinks } from "@/lib/comment-mentions"
import { cn } from "@/lib/utils"

export function SharedMessageBody({
  content,
  mentionOptions,
  className,
}: {
  content: string
  mentionOptions: MentionOptions
  className?: string
}) {
  const live = mentionLookup(mentionOptions)
  const markdown = mentionsAsMarkdownLinks(content, (ref) => {
    const option = live.get(`${ref.kind}:${ref.id}`)
    return option ? { name: option.name, outside: option.outsideWorkspace } : undefined
  })
  return (
    <MarkdownContent className={className} linkComponent={MentionAwareLink}>
      {markdown}
    </MarkdownContent>
  )
}

export type EditableMessage = {
  id: string
  content: string
  editedAt?: string | null
  canEdit?: boolean
}

export function EditedMarker({ editedAt, className }: { editedAt: string; className?: string }) {
  const when = new Date(editedAt)
  const title = Number.isNaN(when.getTime()) ? undefined : `Edited ${when.toLocaleString()}`
  return (
    <span data-testid="message-edited-marker" title={title} className={cn("text-[11px] text-text-subtle", className)}>
      Edited
    </span>
  )
}

export function SharedMessageContent({
  message,
  authorLabel,
  workspaceId,
  conversationId,
  mentionOptions,
  onOpenMentions,
  onEdited,
  bodyClassName,
  onPrimary = false,
}: {
  message: EditableMessage
  /** Display name of the author, used in the accessible names ("Edit comment by Dana"). */
  authorLabel: string
  workspaceId: string
  conversationId: string | null
  mentionOptions: MentionOptions
  onOpenMentions?: () => void
  onEdited: (edit: { id: string; content: string; editedAt: string }) => void
  bodyClassName?: string
  /** True on the filled primary bubble, where the usual subdued text colour would be unreadable. */
  onPrimary?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(() => {
    setDraft(message.content)
    setError(null)
    setEditing(true)
    onOpenMentions?.()
  }, [message.content, onOpenMentions])
  const close = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const save = useCallback(async () => {
    const content = draft.trim()
    if (!content || saving || !conversationId) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/agent/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) },
      )
      if (!res.ok) {
        // Server errors are fixed sentences that never carry message text; anything else gets the generic line.
        setError(res.status === 403 ? "You can't edit this message." : "The message could not be saved.")
        return
      }
      const body = (await res.json()) as { message?: { content?: string; editedAt?: string } }
      onEdited({
        id: message.id,
        content: body.message?.content ?? content,
        editedAt: body.message?.editedAt ?? new Date().toISOString(),
      })
      setEditing(false)
    } catch {
      setError("The message could not be saved.")
    } finally {
      setSaving(false)
    }
  }, [draft, saving, conversationId, message.id, workspaceId, onEdited])

  // Escape closes just the editor, never the panel around the conversation.
  const swallowEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") event.stopPropagation()
  }

  if (editing) {
    return (
      <form
        data-testid="message-edit-form"
        className="flex flex-col gap-2"
        onKeyDown={swallowEscape}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <MentionEditor
          autoFocus
          options={mentionOptions}
          initialValue={message.content}
          ariaLabel={`Edit comment by ${authorLabel}`}
          placeholder="Edit comment…"
          disabled={saving}
          testId="message-edit-input"
          onChange={setDraft}
          onSubmitShortcut={() => void save()}
          onEscape={close}
        />
        {error && (
          <p role="alert" className="text-xs text-status-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" data-testid="message-edit-save" disabled={saving || !draft.trim()}>
            Save edit
          </Button>
          <Button size="sm" variant="ghost" type="button" data-testid="message-edit-cancel" disabled={saving} onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  return (
    <>
      <SharedMessageBody content={message.content} mentionOptions={mentionOptions} className={bodyClassName} />
      {(message.editedAt || message.canEdit) && (
        <div className="mt-1 flex items-center gap-2">
          {message.editedAt && <EditedMarker editedAt={message.editedAt} className={onPrimary ? "text-primary-foreground/80" : undefined} />}
          {message.canEdit && (
            <button
              type="button"
              data-testid="message-edit-button"
              aria-label={`Edit comment by ${authorLabel}`}
              onClick={open}
              className={cn(
                "rounded px-1 text-[11px] font-medium underline-offset-2 hover:underline",
                onPrimary ? "text-primary-foreground/80" : "text-text-subtle",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              )}
            >
              Edit
            </button>
          )}
        </div>
      )}
    </>
  )
}
