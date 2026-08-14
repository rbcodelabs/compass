"use client"

import { useMemo, useState } from "react"
import { Check, RotateCcw, Trash2, MessageSquare, CornerDownRight } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { relativeTime } from "@/lib/relative-time"
import { cn } from "@/lib/utils"

/** Serializable comment shape passed from the doc page → editor → sidebar. */
export interface DocCommentItem {
  id: string
  parentId: string | null
  body: string
  status: string
  anchorText: string | null
  anchorStart: number | null
  anchorEnd: number | null
  anchorPrefix: string | null
  anchorSuffix: string | null
  authorName: string
  authorType: string
  createdAt: Date
}

interface DocCommentsSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  comments: DocCommentItem[]
  /** IDs of root comments whose anchor no longer resolves in the current text. */
  orphanedIds: Set<string>
  onAddReply: (parentId: string, body: string) => Promise<void>
  onResolve: (commentId: string, resolved: boolean) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onFocusComment: (commentId: string) => void
}

export function DocCommentsSidebar({
  open,
  onOpenChange,
  comments,
  orphanedIds,
  onAddReply,
  onResolve,
  onDelete,
  onFocusComment,
}: DocCommentsSidebarProps) {
  const [showResolved, setShowResolved] = useState(false)

  const { roots, repliesByParent } = useMemo(() => {
    const roots = comments
      .filter((c) => c.parentId === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const repliesByParent = new Map<string, DocCommentItem[]>()
    for (const c of comments) {
      if (c.parentId) {
        const arr = repliesByParent.get(c.parentId) ?? []
        arr.push(c)
        repliesByParent.set(c.parentId, arr)
      }
    }
    for (const arr of repliesByParent.values()) {
      arr.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    }
    return { roots, repliesByParent }
  }, [comments])

  const visibleRoots = showResolved ? roots : roots.filter((r) => r.status === "OPEN")
  const resolvedCount = roots.filter((r) => r.status === "RESOLVED").length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-4 pt-4 pb-2 border-b border-border-default shrink-0">
          <SheetTitle className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4" />
            Comments
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto min-h-0 p-3" data-testid="doc-comments-list">
          {visibleRoots.length === 0 ? (
            <p className="text-xs text-text-subtle px-1 py-3">
              {roots.length === 0
                ? "No comments yet. Select some text and click the comment button in the toolbar to start a thread."
                : "No open comments. Toggle “Show resolved” below to see resolved threads."}
            </p>
          ) : (
            <ul className="space-y-3">
              {visibleRoots.map((root) => (
                <CommentThread
                  key={root.id}
                  root={root}
                  replies={repliesByParent.get(root.id) ?? []}
                  orphaned={orphanedIds.has(root.id)}
                  onAddReply={onAddReply}
                  onResolve={onResolve}
                  onDelete={onDelete}
                  onFocusComment={onFocusComment}
                />
              ))}
            </ul>
          )}
        </div>

        {resolvedCount > 0 && (
          <div className="border-t border-border-default px-4 py-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              className="text-xs text-text-subtle hover:text-text-primary"
            >
              {showResolved
                ? "Hide resolved"
                : `Show resolved (${resolvedCount})`}
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function CommentThread({
  root,
  replies,
  orphaned,
  onAddReply,
  onResolve,
  onDelete,
  onFocusComment,
}: {
  root: DocCommentItem
  replies: DocCommentItem[]
  orphaned: boolean
  onAddReply: (parentId: string, body: string) => Promise<void>
  onResolve: (commentId: string, resolved: boolean) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onFocusComment: (commentId: string) => void
}) {
  const [replyBody, setReplyBody] = useState("")
  const [busy, setBusy] = useState(false)
  const isResolved = root.status === "RESOLVED"
  const hasAnchor = Boolean(root.anchorText)

  async function submitReply() {
    const body = replyBody.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await onAddReply(root.id, body)
      setReplyBody("")
    } finally {
      setBusy(false)
    }
  }

  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className={cn(
        "rounded-lg border border-border-default bg-surface-card p-3",
        isResolved && "opacity-70"
      )}
      data-testid="doc-comment-thread"
      data-status={root.status}
    >
      {/* Anchor context */}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        {hasAnchor && !orphaned && (
          <button
            type="button"
            onClick={() => onFocusComment(root.id)}
            title="Jump to highlighted text"
            className="text-[11px] px-1.5 py-0.5 rounded bg-status-info-surface text-status-info hover:opacity-80 max-w-[220px] truncate"
          >
            “{root.anchorText}”
          </button>
        )}
        {hasAnchor && orphaned && (
          <span
            className="text-[11px] px-1.5 py-0.5 rounded bg-surface-inset text-text-subtle italic"
            title="The text this comment was anchored to has changed or been removed"
            data-testid="doc-comment-orphaned"
          >
            orphaned
          </span>
        )}
        {!hasAnchor && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-inset text-text-subtle">
            general
          </span>
        )}
        {isResolved && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-status-success-surface text-status-success">
            resolved
          </span>
        )}
      </div>

      <CommentBody comment={root} />

      {/* Replies */}
      {replies.length > 0 && (
        <ul className="mt-2 space-y-2 pl-3 border-l border-border-default">
          {replies.map((reply) => (
            <li key={reply.id} className="flex gap-1.5">
              <CornerDownRight className="w-3 h-3 mt-1 text-text-subtle shrink-0" />
              <div className="flex-1">
                <CommentBody comment={reply} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={busy}
          onClick={() => run(() => onResolve(root.id, !isResolved))}
        >
          {isResolved ? (
            <>
              <RotateCcw className="w-3 h-3" /> Reopen
            </>
          ) : (
            <>
              <Check className="w-3 h-3" /> Resolve
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-status-danger"
          disabled={busy}
          onClick={() => run(() => onDelete(root.id))}
          title="Delete thread"
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>

      {/* Reply composer */}
      {!isResolved && (
        <div className="mt-2">
          <Textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Reply…"
            rows={2}
            className="text-xs min-h-0"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submitReply()
              }
            }}
          />
          <div className="flex justify-end mt-1">
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy || replyBody.trim().length === 0}
              onClick={() => void submitReply()}
            >
              Reply
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

function CommentBody({ comment }: { comment: DocCommentItem }) {
  return (
    <div>
      <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">{comment.body}</p>
      <p className="text-[11px] text-text-subtle mt-0.5">
        {comment.authorName}
        {comment.authorType === "AGENT" && " (agent)"} — {relativeTime(comment.createdAt)}
      </p>
    </div>
  )
}
