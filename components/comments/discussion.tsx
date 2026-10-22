"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MarkdownContent } from "@/components/markdown-content"
import { MentionAwareLink, mentionLookup } from "@/components/comments/mention-chips"
import { CommentTaskCard } from "@/components/docs/comment-task-card"
import { DocCommentComposer, type ComposerPayload, type ComposerResult } from "@/components/docs/doc-comment-composer"
import { MentionEditor, type MentionOptions } from "@/components/docs/mention-editor"
import { useWorkItemLinkScope } from "@/components/work-item-link-scope"
import { mentionsAsMarkdownLinks } from "@/lib/comment-mentions"
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import type { BrowserCommentDto } from "@/lib/comment-browser"
import type { CommentTargetType } from "@/lib/comments"

type Editor = { kind: "reply" | "edit"; commentId: string } | null
type MentionContext = { options: MentionOptions; confirmedAgentIds: string[]; targetTitle: string | null }
type LoadedDiscussion = { items: BrowserCommentDto[]; mention?: MentionContext; taskCards?: Record<string, CommentTaskCardData> }

const NO_OPTIONS: MentionOptions = { people: [], agents: [], outside: [] }
/** Singular, lower-case noun for the composer copy ("Links back to this comment on the roadmap item"). */
const targetNoun = (targetType: CommentTargetType) => targetType.toLowerCase().replace(/_/g, " ")

function chronological(items: BrowserCommentDto[]): BrowserCommentDto[] {
  return [...items]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((item) => ({ ...item, replies: chronological(item.replies) }))
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "The discussion could not be updated."
    throw new Error(message)
  }
  return payload as T
}

function updateComment(items: BrowserCommentDto[], replacement: BrowserCommentDto): BrowserCommentDto[] {
  return items.map((item) => item.id === replacement.id
    ? { ...replacement, replies: replacement.replies.length ? replacement.replies : item.replies }
    : { ...item, replies: updateComment(item.replies, replacement) })
}

function removeComment(items: BrowserCommentDto[], commentId: string): BrowserCommentDto[] {
  return items.filter((item) => item.id !== commentId).map((item) => ({ ...item, replies: removeComment(item.replies, commentId) }))
}

function timestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function Discussion({ targetType, targetId, refreshKey, render }: {
  targetType: CommentTargetType
  targetId: string
  refreshKey?: number
  /** Keep the controller mounted above a shell whose portal/docked body can remount. */
  render?: (content: ReactNode) => ReactNode
}) {
  const [items, setItems] = useState<BrowserCommentDto[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [actionError, setActionError] = useState("")
  const [mention, setMention] = useState<MentionContext>({ options: NO_OPTIONS, confirmedAgentIds: [], targetTitle: null })
  const [taskCards, setTaskCards] = useState<Record<string, CommentTaskCardData>>({})
  const taskScope = useWorkItemLinkScope()
  // Tagged with its target so a draft typed for one target can never seed the composer of the next.
  const [rootDraftState, setRootDraft] = useState({ key: "", text: "" })
  const [editor, setEditor] = useState<Editor>(null)
  const [editorBody, setEditorBody] = useState("")
  const [busy, setBusy] = useState("")
  const [expandedResolved, setExpandedResolved] = useState<Set<string>>(new Set())
  const returnFocusLabel = useRef("")
  const requestGeneration = useRef(0)
  const activeLoad = useRef<AbortController | null>(null)
  const lastRefresh = useRef(refreshKey)
  const loadedTarget = useRef({ targetType, targetId })

  const load = useCallback(async (reset = false) => {
    activeLoad.current?.abort()
    const controller = new AbortController()
    activeLoad.current = controller
    const generation = requestGeneration.current
    if (reset) {
      setItems(null)
      setLoadError("")
      setActionError("")
      setMention({ options: NO_OPTIONS, confirmedAgentIds: [], targetTitle: null })
      setTaskCards({})
      setRootDraft({ key: "", text: "" })
      setEditor(null)
      setEditorBody("")
      setBusy("")
      setExpandedResolved(new Set())
    }
    setLoadError("")
    try {
      const query = new URLSearchParams({ targetType, targetId })
      const payload = await responseJson<LoadedDiscussion>(await fetch(`/api/comments?${query}`, { signal: controller.signal }))
      if (controller.signal.aborted || generation !== requestGeneration.current) return
      setItems(chronological(payload.items))
      if (payload.mention) setMention(payload.mention)
      if (payload.taskCards) setTaskCards(payload.taskCards)
    } catch (error) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return
      setLoadError(error instanceof Error ? error.message : "Could not load discussion.")
    }
  }, [targetId, targetType])

  useEffect(() => {
    requestGeneration.current += 1
    activeLoad.current?.abort()
    const reset = loadedTarget.current.targetType !== targetType || loadedTarget.current.targetId !== targetId
    const timer = window.setTimeout(() => {
      loadedTarget.current = { targetType, targetId }
      void load(reset)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      activeLoad.current?.abort()
    }
  }, [load, targetType, targetId])

  useEffect(() => {
    if (lastRefresh.current === refreshKey || busy) return
    // Reopening refreshes remote comments, but never resets an unfinished draft.
    const timer = window.setTimeout(() => {
      lastRefresh.current = refreshKey
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshKey, busy, load])

  function closeEditor() {
    setEditor(null)
    setEditorBody("")
    setActionError("")
    queueMicrotask(() => {
      const label = returnFocusLabel.current
      const candidates = document.querySelectorAll<HTMLElement>("button[aria-label]")
      Array.from(candidates).find((candidate) => candidate.getAttribute("aria-label") === label)?.focus()
    })
  }

  function openEditor(next: NonNullable<Editor>, body: string, trigger: HTMLElement) {
    returnFocusLabel.current = trigger.getAttribute("aria-label") ?? ""
    setEditor(next)
    setEditorBody(body)
    setActionError("")
  }

  /** Posts through the composer. Failures come back as values so the composer can show its own copy. */
  async function post(payload: ComposerPayload, parentId: string | null): Promise<ComposerResult> {
    const generation = requestGeneration.current
    const key = parentId ? `reply:${parentId}` : "root"
    activeLoad.current?.abort()
    setBusy(key)
    setActionError("")
    try {
      const response = await fetch("/api/comments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType, targetId, parentId, body: payload.body,
          ...(payload.task ? { task: payload.task, assignee: payload.assignee, agentScopeConfirmed: payload.agentScopeConfirmed } : {}),
        }),
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const failure = typeof result === "object" && result ? result as { error?: unknown; code?: unknown } : {}
        const message = typeof failure.error === "string" ? failure.error : "The comment could not be posted."
        return { ok: false, error: typeof failure.code === "string" ? failure.code : "ERROR", message }
      }
      const { taskCard, ...created } = result as BrowserCommentDto & { taskCard?: CommentTaskCardData | null }
      if (generation !== requestGeneration.current) return { ok: true }
      if (taskCard) {
        setTaskCards((current) => ({ ...current, [created.id]: taskCard }))
        const agentId = taskCard.assignee?.type === "AGENT" ? taskCard.assignee.id : null
        if (agentId) setMention((current) => ({ ...current, confirmedAgentIds: [...new Set([...current.confirmedAgentIds, agentId])] }))
      }
      if (parentId) {
        setItems((current) => (current ?? []).map((root) => root.id === parentId
          ? { ...root, canDelete: false, replies: chronological([...root.replies, created]) }
          : root))
        closeEditor()
      } else {
        setItems((current) => chronological([...(current ?? []), created]))
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: "ERROR", message: error instanceof Error ? error.message : "The comment could not be posted." }
    } finally { if (generation === requestGeneration.current) setBusy("") }
  }

  async function edit(commentId: string) {
    const generation = requestGeneration.current
    if (!editorBody.trim()) { setActionError("Enter a comment."); return }
    activeLoad.current?.abort()
    setBusy(`edit:${commentId}`)
    setActionError("")
    try {
      const updated = await responseJson<BrowserCommentDto>(await fetch(`/api/comments/${commentId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", body: editorBody }),
      }))
      if (generation !== requestGeneration.current) return
      setItems((current) => updateComment(current ?? [], updated))
      closeEditor()
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setActionError(error instanceof Error ? error.message : "The edit could not be saved.")
    } finally { if (generation === requestGeneration.current) setBusy("") }
  }

  async function changeStatus(comment: BrowserCommentDto) {
    const generation = requestGeneration.current
    const action = comment.status === "RESOLVED" ? "reopen" : "resolve"
    activeLoad.current?.abort()
    setBusy(`${action}:${comment.id}`)
    setActionError("")
    try {
      const updated = await responseJson<BrowserCommentDto>(await fetch(`/api/comments/${comment.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      }))
      if (generation !== requestGeneration.current) return
      setItems((current) => updateComment(current ?? [], updated))
      if (action === "resolve") setExpandedResolved((current) => { const next = new Set(current); next.delete(comment.id); return next })
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setActionError(error instanceof Error ? error.message : "The thread status could not be changed.")
    } finally { if (generation === requestGeneration.current) setBusy("") }
  }

  async function remove(comment: BrowserCommentDto, isRoot: boolean) {
    const generation = requestGeneration.current
    const deletesThread = isRoot && comment.replies.length > 0
    if (deletesThread && !window.confirm("Delete this comment and every reply? This cannot be undone.")) return
    activeLoad.current?.abort()
    setBusy(`delete:${comment.id}`)
    setActionError("")
    try {
      const suffix = deletesThread ? "?deleteThread=true" : ""
      await responseJson(await fetch(`/api/comments/${comment.id}${suffix}`, { method: "DELETE" }))
      if (generation !== requestGeneration.current) return
      setItems((current) => removeComment(current ?? [], comment.id))
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setActionError(error instanceof Error ? error.message : "The comment could not be deleted.")
    } finally { if (generation === requestGeneration.current) setBusy("") }
  }

  // Escape in a reply/edit editor closes just that editor, never the panel around the discussion.
  const swallowEscape = (event: React.KeyboardEvent) => { if (event.key === "Escape") event.stopPropagation() }
  const liveMentions = mentionLookup(mention.options)
  const renderedBody = (body: string) => mentionsAsMarkdownLinks(body, (ref) => {
    const option = liveMentions.get(`${ref.kind}:${ref.id}`)
    return option ? { name: option.name, outside: option.outsideWorkspace } : undefined
  })

  const draftKey = `${targetType}:${targetId}`

  const renderComment = (comment: BrowserCommentDto, isRoot: boolean) => {
    const resolved = comment.status === "RESOLVED"
    const collapsed = isRoot && resolved && !expandedResolved.has(comment.id)
    const editing = editor?.kind === "edit" && editor.commentId === comment.id
    return (
      <article key={comment.id} className={`min-w-0 rounded-lg border p-3 ${resolved ? "border-border bg-muted/50" : "border-border bg-background"}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <strong className="truncate text-foreground">{comment.authorName}</strong>
          {comment.authorType === "AGENT" && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">Agent</Badge>}
          {resolved && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">Resolved</Badge>}
          {comment.edited && <span className="text-muted-foreground">Edited</span>}
          <time className="text-muted-foreground" dateTime={comment.createdAt}>{timestamp(comment.createdAt)}</time>
        </div>

        {collapsed ? (
          <div className="mt-2 flex flex-wrap gap-1">
            <Button type="button" variant="ghost" size="xs" aria-label={`Expand resolved thread by ${comment.authorName}`} onClick={() => setExpandedResolved((current) => new Set(current).add(comment.id))}>Show resolved thread ({comment.replies.length} {comment.replies.length === 1 ? "reply" : "replies"})</Button>
            {comment.canModerate && <Button type="button" variant="ghost" size="xs" aria-label={`Reopen thread by ${comment.authorName}`} disabled={busy === `reopen:${comment.id}`} onClick={() => void changeStatus(comment)}>Reopen</Button>}
          </div>
        ) : (
          <>
            {resolved && isRoot && <Button type="button" variant="ghost" size="xs" className="mt-2" aria-label={`Collapse resolved thread by ${comment.authorName}`} onClick={() => setExpandedResolved((current) => { const next = new Set(current); next.delete(comment.id); return next })}>Collapse thread</Button>}
            {editing ? (
              <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void edit(comment.id) }}>
                <div onKeyDown={swallowEscape}>
                  <MentionEditor autoFocus options={mention.options} initialValue={editorBody} ariaLabel={`Edit comment by ${comment.authorName}`} placeholder="Edit comment…" disabled={busy === `edit:${comment.id}`} onChange={setEditorBody} onSubmitShortcut={() => void edit(comment.id)} onEscape={closeEditor} />
                </div>
                <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={busy === `edit:${comment.id}`}>Save edit</Button><Button size="sm" variant="ghost" type="button" onClick={closeEditor}>Cancel</Button></div>
              </form>
            ) : <MarkdownContent className="mt-2" linkComponent={MentionAwareLink}>{renderedBody(comment.body)}</MarkdownContent>}
            {!editing && taskCards[comment.id] && <CommentTaskCard card={taskCards[comment.id]} taskHref={`${taskScope ? `/${taskScope.orgSlug}/${taskScope.workspaceSlug}` : ""}/tasks/${taskCards[comment.id].taskId}`} />}

            {!editing && <div className="mt-2 flex flex-wrap gap-1">
              {isRoot && <Button type="button" variant="ghost" size="xs" aria-label={`Reply to ${comment.authorName}`} disabled={Boolean(busy)} onClick={(event) => openEditor({ kind: "reply", commentId: comment.id }, "", event.currentTarget)}>Reply</Button>}
              {comment.canEdit && <Button type="button" variant="ghost" size="xs" aria-label={`Edit comment by ${comment.authorName}`} disabled={Boolean(busy)} onClick={(event) => openEditor({ kind: "edit", commentId: comment.id }, comment.body, event.currentTarget)}>Edit</Button>}
              {isRoot && comment.canModerate && <Button type="button" variant="ghost" size="xs" aria-label={`${resolved ? "Reopen" : "Resolve"} thread by ${comment.authorName}`} disabled={busy.endsWith(`:${comment.id}`)} onClick={() => void changeStatus(comment)}>{resolved ? "Reopen" : "Resolve"}</Button>}
              {comment.canDelete && <Button type="button" variant="ghost" size="xs" className="text-destructive" aria-label={`Delete ${isRoot && comment.replies.length ? "thread" : "comment"} by ${comment.authorName}`} disabled={busy === `delete:${comment.id}`} onClick={() => void remove(comment, isRoot)}>Delete</Button>}
            </div>}

            {isRoot && editor?.kind === "reply" && editor.commentId === comment.id && (
              <div className="mt-3 border-l-2 border-border pl-3" onKeyDown={swallowEscape}>
                <DocCommentComposer
                  compact autoFocus initialBody={editorBody} onBodyChange={setEditorBody}
                  options={mention.options} confirmedAgentIds={mention.confirmedAgentIds}
                  docTitle={mention.targetTitle ?? ""} targetNoun={targetNoun(targetType)}
                  ariaLabel={`Reply to ${comment.authorName}`} placeholder="Reply…" idleLabel="Post reply"
                  onSubmit={(payload) => post(payload, comment.id)} onCancel={closeEditor}
                />
              </div>
            )}
            {isRoot && comment.replies.length > 0 && <div className="mt-3 space-y-2 border-l-2 border-border pl-3">{chronological(comment.replies).map((reply) => renderComment(reply, false))}</div>}
          </>
        )}
      </article>
    )
  }

  const content = (
    <section aria-labelledby={`discussion-${targetType}-${targetId}`} aria-busy={busy ? "true" : undefined} className="min-w-0 space-y-3 border-t border-border pt-4">
      <div><h3 id={`discussion-${targetType}-${targetId}`} className="text-sm font-semibold">Discussion</h3><p className="text-xs text-muted-foreground">Comments are discussion, not decisions or authorization.</p></div>
      {items === null && !loadError && <p role="status" className="text-sm text-muted-foreground">Loading discussion…</p>}
      {loadError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">{loadError}</p><Button type="button" variant="outline" size="sm" aria-label="Retry discussion" disabled={Boolean(busy)} onClick={() => void load()}>Retry</Button></div>}
      {items?.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      {items && items.length > 0 && <div className="space-y-3">{chronological(items).map((item) => renderComment(item, true))}</div>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      <DocCommentComposer
        key={draftKey}
        options={mention.options} confirmedAgentIds={mention.confirmedAgentIds}
        docTitle={mention.targetTitle ?? ""} targetNoun={targetNoun(targetType)}
        ariaLabel="Add comment" placeholder="Add to the discussion…" idleLabel="Post comment"
        initialBody={rootDraftState.key === draftKey ? rootDraftState.text : ""} onBodyChange={(text) => setRootDraft({ key: draftKey, text })}
        disabled={items === null} onSubmit={(payload) => post(payload, null)}
      />
    </section>
  )
  return render ? render(content) : content
}
