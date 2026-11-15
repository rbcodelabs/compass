"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Loader2, Pencil, Send, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime, type AgentBoardCardProposedReply } from "@/lib/agent-board"
import { cn } from "@/lib/utils"

type ProposedReplyDraft = {
  editing: boolean
  text: string
  seededFrom: string
}

/**
 * Module-scoped draft map keyed by `${conversationId}:proposed_reply` so SSE board patches,
 * column transitions, or view switches never wipe a half-edited proposed reply.
 */
const proposedReplyDrafts = new Map<string, ProposedReplyDraft>()

export function clearProposedReplyDraft(conversationId: string): void {
  proposedReplyDrafts.delete(`${conversationId}:proposed_reply`)
}

export type ProposedReplyApprovalResult = {
  conversationId: string
  text: string
  runId: string | null
}

type ProposedReplyCardProps = {
  workspaceId: string
  conversationId: string
  proposedReply: AgentBoardCardProposedReply
  compact?: boolean
  now?: number
  onApproved?: (result: ProposedReplyApprovalResult) => void
  onDiscarded?: () => void
  onEditInChat?: (text: string) => void
  className?: string
}

/**
 * Renders an orchestrator-staged `ProposedReply` inline on a `Needs you` Board card or
 * above the `AgentChat` composer, with **Approve & Send**, **Edit** (draft-safe inline
 * editor + optional handoff to Chat composer), and **Discard** actions.
 */
export function ProposedReplyCard({
  workspaceId,
  conversationId,
  proposedReply,
  compact = false,
  now,
  onApproved,
  onDiscarded,
  onEditInChat,
  className,
}: ProposedReplyCardProps) {
  const draftKey = `${conversationId}:proposed_reply`
  const [draft, setDraft] = useState<ProposedReplyDraft>(() => {
    const existing = proposedReplyDrafts.get(draftKey)
    if (existing && (existing.editing || existing.seededFrom === proposedReply.text)) {
      return existing
    }
    const fresh: ProposedReplyDraft = {
      editing: false,
      text: proposedReply.text,
      seededFrom: proposedReply.text,
    }
    proposedReplyDrafts.set(draftKey, fresh)
    return fresh
  })
  const [optimisticallyResolved, setOptimisticallyResolved] = useState(false)
  const [submitting, setSubmitting] = useState<"approve" | "discard" | null>(null)
  const [error, setError] = useState<string | null>(null)

  // If the orchestrator stages a brand-new reply while the user is NOT actively editing, sync it.
  useEffect(() => {
    setDraft((prev) => {
      if (prev.editing || prev.seededFrom === proposedReply.text) return prev
      const updated: ProposedReplyDraft = {
        editing: false,
        text: proposedReply.text,
        seededFrom: proposedReply.text,
      }
      proposedReplyDrafts.set(draftKey, updated)
      return updated
    })
  }, [draftKey, proposedReply.text])

  const updateDraft = useCallback(
    (updater: (prev: ProposedReplyDraft) => ProposedReplyDraft) => {
      setError(null)
      setDraft((prev) => {
        const next = updater(prev)
        proposedReplyDrafts.set(draftKey, next)
        return next
      })
    },
    [draftKey],
  )

  const handleApprove = useCallback(async () => {
    const finalText = (draft.editing ? draft.text : proposedReply.text).trim()
    if (!finalText || submitting) return
    setSubmitting("approve")
    setError(null)
    try {
      const response = await fetch(`/api/agent/conversations/${conversationId}/supervision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve_proposed_reply",
          workspaceId,
          text: finalText,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        runId?: string | null
        text?: string
        error?: string
      }
      if (!response.ok) {
        throw new Error(body.error ?? `Could not approve proposed reply (HTTP ${response.status}).`)
      }
      proposedReplyDrafts.delete(draftKey)
      setOptimisticallyResolved(true)
      onApproved?.({
        conversationId,
        text: body.text ?? finalText,
        runId: body.runId ?? null,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve proposed reply.")
    } finally {
      setSubmitting(null)
    }
  }, [conversationId, draft.editing, draft.text, draftKey, onApproved, proposedReply.text, submitting, workspaceId])

  const handleDiscard = useCallback(async () => {
    if (submitting) return
    setSubmitting("discard")
    setError(null)
    try {
      const response = await fetch(`/api/agent/conversations/${conversationId}/supervision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "discard_proposed_reply",
          workspaceId,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        throw new Error(body.error ?? `Could not discard proposed reply (HTTP ${response.status}).`)
      }
      proposedReplyDrafts.delete(draftKey)
      setOptimisticallyResolved(true)
      onDiscarded?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not discard proposed reply.")
    } finally {
      setSubmitting(null)
    }
  }, [conversationId, draftKey, onDiscarded, submitting, workspaceId])

  if (optimisticallyResolved || !proposedReply.text.trim()) return null

  const effectiveText = draft.editing ? draft.text : proposedReply.text

  return (
    <div
      data-testid={compact ? "board-card-proposed-reply" : "chat-proposed-reply"}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "relative z-10 rounded-xl border border-status-info/35 bg-surface-inset/90 text-left shadow-xs",
        compact ? "p-2.5" : "p-3.5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-status-info">
          <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Proposed reply</span>
        </span>
        {proposedReply.generatedAt && (
          <span className="text-[10px] text-text-subtle">
            staged {formatRelativeTime(proposedReply.generatedAt, now)}
          </span>
        )}
      </div>

      {draft.editing ? (
        <textarea
          data-testid="proposed-reply-textarea"
          value={draft.text}
          disabled={submitting !== null}
          rows={compact ? 3 : 4}
          aria-label="Edit proposed reply"
          onChange={(e) =>
            updateDraft((prev) => ({
              ...prev,
              text: e.target.value,
            }))
          }
          className="mt-2 w-full resize-y rounded-lg border border-border-default bg-surface-card p-2 text-xs leading-relaxed text-text-primary placeholder:text-text-subtle focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        />
      ) : (
        <p
          data-testid="proposed-reply-text"
          className={cn(
            "mt-1.5 whitespace-pre-wrap rounded-lg border border-border-default/70 bg-surface-card/80 px-2.5 py-2 text-text-primary",
            compact ? "line-clamp-4 text-xs leading-4" : "text-xs leading-5",
          )}
        >
          {effectiveText}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-status-danger">
          {error}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="proposed-reply-edit"
            disabled={submitting !== null}
            onClick={() => {
              if (onEditInChat && !draft.editing) {
                onEditInChat(proposedReply.text)
                return
              }
              updateDraft((prev) => ({
                ...prev,
                editing: !prev.editing,
                text: prev.editing ? prev.text : prev.text || proposedReply.text,
              }))
            }}
            className="h-7 gap-1 px-2 text-xs text-text-secondary hover:text-text-primary"
          >
            {draft.editing ? (
              <>
                <Check aria-hidden="true" className="size-3" />
                Done editing
              </>
            ) : (
              <>
                <Pencil aria-hidden="true" className="size-3" />
                Edit
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="proposed-reply-discard"
            disabled={submitting !== null}
            onClick={() => void handleDiscard()}
            className="h-7 gap-1 px-2 text-xs text-text-subtle hover:text-status-danger"
          >
            {submitting === "discard" ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : (
              <X aria-hidden="true" className="size-3" />
            )}
            Discard
          </Button>
        </div>

        <Button
          type="button"
          size="sm"
          data-testid="proposed-reply-approve"
          disabled={submitting !== null || !effectiveText.trim()}
          onClick={() => void handleApprove()}
          className="h-7 gap-1.5 px-2.5 text-xs"
        >
          {submitting === "approve" ? (
            <>
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Send aria-hidden="true" className="size-3" />
              Approve &amp; Send
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
