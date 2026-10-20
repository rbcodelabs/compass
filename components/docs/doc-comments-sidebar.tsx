"use client"

import { useMemo, useState } from "react"
import { Check, RotateCcw, Trash2, MessageSquare, CornerDownRight } from "lucide-react"
import { DocPanelShell } from "@/components/docs/doc-panel-shell"
import type { PanelPin } from "@/lib/panel-pin"
import { Button } from "@/components/ui/button"
import { relativeTime } from "@/lib/relative-time"
import { cn } from "@/lib/utils"
import { bodySegments } from "@/lib/comment-mentions"
import type { CommentTaskCardData } from "@/lib/comment-task-card"
import { CommentTaskCard } from "@/components/docs/comment-task-card"
import { DocCommentComposer, type ComposerPayload, type ComposerResult } from "@/components/docs/doc-comment-composer"
import type { MentionOption, MentionOptions } from "@/components/docs/mention-editor"

const NO_MENTION_OPTIONS: MentionOptions = { people: [], agents: [], outside: [] }

/** What the thread UI needs to render mentions and task cards and to compose replies. */
interface MentionContext {
  options: MentionOptions
  confirmedAgentIds: string[]
  docTitle: string
  taskCards: Record<string, CommentTaskCardData>
  taskHrefBase: string
}

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
  initialPin?: PanelPin
  open: boolean
  onOpenChange: (open: boolean) => void
  comments: DocCommentItem[]
  /** IDs of root comments whose anchor no longer resolves in the current text. */
  orphanedIds: Set<string>
  onAddReply: (parentId: string, payload: ComposerPayload) => Promise<ComposerResult | void>
  onResolve: (commentId: string, resolved: boolean) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onFocusComment: (commentId: string) => void
  /** Pickable people and agents for @mentions. Omit to render replies without a picker. */
  mentionOptions?: MentionOptions
  confirmedAgentIds?: string[]
  docTitle?: string
  /** Task card per comment id. */
  taskCards?: Record<string, CommentTaskCardData>
  /** e.g. /org/workspace/tasks; the card links to taskHrefBase/taskId. */
  taskHrefBase?: string
}

export function DocCommentsSidebar({
  initialPin,
  open,
  onOpenChange,
  comments,
  orphanedIds,
  onAddReply,
  onResolve,
  onDelete,
  onFocusComment,
  mentionOptions = NO_MENTION_OPTIONS,
  confirmedAgentIds = [],
  docTitle = "",
  taskCards = {},
  taskHrefBase = "/tasks",
}: DocCommentsSidebarProps) {
  const [showResolved, setShowResolved] = useState(false)
  const mention: MentionContext = { options: mentionOptions, confirmedAgentIds, docTitle, taskCards, taskHrefBase }

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
    <DocPanelShell panelId="docsComments" title="Comments" icon={<MessageSquare className="w-4 h-4" />} open={open} onOpenChange={onOpenChange} initialPin={initialPin}>
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
                  mention={mention}
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
    </DocPanelShell>
  )
}

function CommentThread({
  root,
  replies,
  orphaned,
  mention,
  onAddReply,
  onResolve,
  onDelete,
  onFocusComment,
}: {
  root: DocCommentItem
  replies: DocCommentItem[]
  orphaned: boolean
  mention: MentionContext
  onAddReply: (parentId: string, payload: ComposerPayload) => Promise<ComposerResult | void>
  onResolve: (commentId: string, resolved: boolean) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onFocusComment: (commentId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const isResolved = root.status === "RESOLVED"
  const hasAnchor = Boolean(root.anchorText)

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

      <CommentBody comment={root} mention={mention} />

      {/* Replies */}
      {replies.length > 0 && (
        <ul className="mt-2 space-y-2 pl-3 border-l border-border-default">
          {replies.map((reply) => (
            <li key={reply.id} className="flex gap-1.5">
              <CornerDownRight className="w-3 h-3 mt-1 text-text-subtle shrink-0" />
              <div className="flex-1">
                <CommentBody comment={reply} mention={mention} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {!isResolved && [root, ...replies].some((c) => mention.taskCards[c.id]) && (
        <p className="mt-2 rounded-md bg-status-success-surface px-2 py-1 text-xs text-status-success" data-testid="thread-auto-resolve-note">
          <Check className="mr-1 inline size-3" aria-hidden />
          When the task is marked <b>Done</b>, this thread resolves automatically. Reopening the task reopens the thread.
        </p>
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
          <DocCommentComposer
            compact
            options={mention.options}
            confirmedAgentIds={mention.confirmedAgentIds}
            docTitle={mention.docTitle}
            anchorText={root.anchorText}
            placeholder="Reply…"
            ariaLabel="Reply"
            idleLabel="Reply"
            onSubmit={async (payload) => (await onAddReply(root.id, payload)) ?? { ok: true }}
          />
        </div>
      )}
    </li>
  )
}

function MentionChips({ body, options }: { body: string; options: MentionOptions }) {
  const live = new Map<string, MentionOption>()
  for (const option of [...options.people, ...options.agents, ...options.outside]) live.set(kindKey(option.kind, option.id), option)
  return (
    <>
      {bodySegments(body).map((segment, index) => {
        if (segment.type === "text") return <span key={index}>{segment.text}</span>
        const { kind, id, label } = segment.mention
        const option = live.get(kindKey(kind, id))
        // Resolve the id to the current name so renames never leave a stale label.
        return (
          <span
            key={index}
            data-testid="comment-mention"
            data-mention-id={id}
            className={cn("mention-chip", kind === "agent" && "mention-chip-agent", option?.outsideWorkspace && "mention-chip-outside")}
          >
            @{option?.name ?? label}
          </span>
        )
      })}
    </>
  )
}

function kindKey(kind: string, id: string): string {
  return kind + ":" + id
}

function CommentBody({ comment, mention }: { comment: DocCommentItem; mention: MentionContext }) {
  const card = mention.taskCards[comment.id]
  return (
    <div>
      <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">
        <MentionChips body={comment.body} options={mention.options} />
      </p>
      <p className="text-[11px] text-text-subtle mt-0.5">
        {comment.authorName}
        {comment.authorType === "AGENT" && " (agent)"} — {relativeTime(comment.createdAt)}
      </p>
      {card && <CommentTaskCard card={card} taskHref={mention.taskHrefBase + "/" + card.taskId} />}
    </div>
  )
}
