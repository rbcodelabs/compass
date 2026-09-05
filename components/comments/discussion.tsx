"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { BrowserCommentDto } from "@/lib/comment-browser"
import type { CommentTargetType } from "@/lib/comments"

type Editor = { kind: "reply" | "edit"; commentId: string } | null

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

export function Discussion({ targetType, targetId }: { targetType: CommentTargetType; targetId: string }) {
  const [items, setItems] = useState<BrowserCommentDto[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [actionError, setActionError] = useState("")
  const [rootBody, setRootBody] = useState("")
  const [editor, setEditor] = useState<Editor>(null)
  const [editorBody, setEditorBody] = useState("")
  const [busy, setBusy] = useState("")
  const [expandedResolved, setExpandedResolved] = useState<Set<string>>(new Set())
  const returnFocusLabel = useRef("")

  const load = useCallback(async (reset = false) => {
    if (reset) {
      setItems(null)
      setEditor(null)
      setActionError("")
    }
    setLoadError("")
    try {
      const query = new URLSearchParams({ targetType, targetId })
      const payload = await responseJson<{ items: BrowserCommentDto[] }>(await fetch(`/api/comments?${query}`))
      setItems(chronological(payload.items))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load discussion.")
    }
  }, [targetId, targetType])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(true), 0)
    return () => window.clearTimeout(timer)
  }, [load])

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

  async function post(body: string, parentId: string | null) {
    const key = parentId ? `reply:${parentId}` : "root"
    if (!body.trim()) {
      setActionError(parentId ? "Enter a reply." : "Enter a comment.")
      return
    }
    setBusy(key)
    setActionError("")
    try {
      const created = await responseJson<BrowserCommentDto>(await fetch("/api/comments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId, parentId, body }),
      }))
      if (parentId) {
        setItems((current) => (current ?? []).map((root) => root.id === parentId
          ? { ...root, canDelete: false, replies: chronological([...root.replies, created]) }
          : root))
        closeEditor()
        void load()
      } else {
        setItems((current) => chronological([...(current ?? []), created]))
        setRootBody("")
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The comment could not be posted.")
    } finally { setBusy("") }
  }

  async function edit(commentId: string) {
    if (!editorBody.trim()) { setActionError("Enter a comment."); return }
    setBusy(`edit:${commentId}`)
    setActionError("")
    try {
      const updated = await responseJson<BrowserCommentDto>(await fetch(`/api/comments/${commentId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", body: editorBody }),
      }))
      setItems((current) => updateComment(current ?? [], updated))
      closeEditor()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The edit could not be saved.")
    } finally { setBusy("") }
  }

  async function changeStatus(comment: BrowserCommentDto) {
    const action = comment.status === "RESOLVED" ? "reopen" : "resolve"
    setBusy(`${action}:${comment.id}`)
    setActionError("")
    try {
      const updated = await responseJson<BrowserCommentDto>(await fetch(`/api/comments/${comment.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      }))
      setItems((current) => updateComment(current ?? [], updated))
      if (action === "resolve") setExpandedResolved((current) => { const next = new Set(current); next.delete(comment.id); return next })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The thread status could not be changed.")
    } finally { setBusy("") }
  }

  async function remove(comment: BrowserCommentDto, isRoot: boolean) {
    const deletesThread = isRoot && comment.replies.length > 0
    if (deletesThread && !window.confirm("Delete this comment and every reply? This cannot be undone.")) return
    setBusy(`delete:${comment.id}`)
    setActionError("")
    try {
      const suffix = deletesThread ? "?deleteThread=true" : ""
      await responseJson(await fetch(`/api/comments/${comment.id}${suffix}`, { method: "DELETE" }))
      setItems((current) => removeComment(current ?? [], comment.id))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The comment could not be deleted.")
    } finally { setBusy("") }
  }

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
                <Textarea autoFocus aria-label={`Edit comment by ${comment.authorName}`} value={editorBody} disabled={busy === `edit:${comment.id}`} onChange={(event) => setEditorBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closeEditor() }} />
                <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={busy === `edit:${comment.id}`}>Save edit</Button><Button size="sm" variant="ghost" type="button" onClick={closeEditor}>Cancel</Button></div>
              </form>
            ) : <p className="mt-2 break-words whitespace-pre-wrap text-sm text-foreground">{comment.body}</p>}

            {!editing && <div className="mt-2 flex flex-wrap gap-1">
              {isRoot && <Button type="button" variant="ghost" size="xs" aria-label={`Reply to ${comment.authorName}`} onClick={(event) => openEditor({ kind: "reply", commentId: comment.id }, "", event.currentTarget)}>Reply</Button>}
              {comment.canEdit && <Button type="button" variant="ghost" size="xs" aria-label={`Edit comment by ${comment.authorName}`} onClick={(event) => openEditor({ kind: "edit", commentId: comment.id }, comment.body, event.currentTarget)}>Edit</Button>}
              {isRoot && comment.canModerate && <Button type="button" variant="ghost" size="xs" aria-label={`${resolved ? "Reopen" : "Resolve"} thread by ${comment.authorName}`} disabled={busy.endsWith(`:${comment.id}`)} onClick={() => void changeStatus(comment)}>{resolved ? "Reopen" : "Resolve"}</Button>}
              {comment.canDelete && <Button type="button" variant="ghost" size="xs" className="text-destructive" aria-label={`Delete ${isRoot && comment.replies.length ? "thread" : "comment"} by ${comment.authorName}`} disabled={busy === `delete:${comment.id}`} onClick={() => void remove(comment, isRoot)}>Delete</Button>}
            </div>}

            {isRoot && editor?.kind === "reply" && editor.commentId === comment.id && (
              <form className="mt-3 space-y-2 border-l-2 border-border pl-3" onSubmit={(event) => { event.preventDefault(); void post(editorBody, comment.id) }}>
                <Textarea autoFocus aria-label={`Reply to ${comment.authorName}`} value={editorBody} disabled={busy === `reply:${comment.id}`} onChange={(event) => setEditorBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closeEditor() }} />
                <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={busy === `reply:${comment.id}`}>Post reply</Button><Button size="sm" variant="ghost" type="button" onClick={closeEditor}>Cancel</Button></div>
              </form>
            )}
            {isRoot && comment.replies.length > 0 && <div className="mt-3 space-y-2 border-l-2 border-border pl-3">{chronological(comment.replies).map((reply) => renderComment(reply, false))}</div>}
          </>
        )}
      </article>
    )
  }

  return (
    <section aria-labelledby={`discussion-${targetType}-${targetId}`} aria-busy={busy ? "true" : undefined} className="min-w-0 space-y-3 border-t border-border pt-4">
      <div><h3 id={`discussion-${targetType}-${targetId}`} className="text-sm font-semibold">Discussion</h3><p className="text-xs text-muted-foreground">Comments are discussion, not decisions or authorization.</p></div>
      {items === null && !loadError && <p role="status" className="text-sm text-muted-foreground">Loading discussion…</p>}
      {loadError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">{loadError}</p><Button type="button" variant="outline" size="sm" aria-label="Retry discussion" onClick={() => void load()}>Retry</Button></div>}
      {items?.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      {items && items.length > 0 && <div className="space-y-3">{chronological(items).map((item) => renderComment(item, true))}</div>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void post(rootBody, null) }}>
        <Textarea aria-label="Add comment" placeholder="Add to the discussion…" value={rootBody} disabled={busy === "root"} onChange={(event) => setRootBody(event.target.value)} />
        <div className="flex justify-end"><Button size="sm" type="submit" disabled={busy === "root"}>{busy === "root" ? "Posting…" : "Post comment"}</Button></div>
      </form>
    </section>
  )
}
