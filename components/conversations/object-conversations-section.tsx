"use client"

import { useCallback, useEffect, useState } from "react"
import { AtSign, Bot, CheckCircle2, MessageSquare, Plus, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConversationPanelOptional } from "@/components/panels/conversation-panel"
import type { ObjectConversationSummary } from "@/app/api/agent/conversations/by-target/route"
import { formatRelativeTime } from "@/lib/agent-board"

export function ObjectConversationsSection({
  targetType,
  targetId,
  targetLabel,
}: {
  targetType: string
  targetId: string
  targetLabel?: string | null
}) {
  const panelCtx = useConversationPanelOptional()
  const workspaceId = panelCtx?.workspaceId
  const normalizedTargetType = targetType.toUpperCase()

  const [items, setItems] = useState<ObjectConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false)
      return
    }
    try {
      const qs = new URLSearchParams({
        workspaceId,
        targetType: normalizedTargetType,
        targetId,
      })
      const res = await fetch(`/api/agent/conversations/by-target?${qs.toString()}`)
      if (!res.ok) return
      const body = (await res.json()) as { items?: ObjectConversationSummary[] }
      if (Array.isArray(body.items)) {
        setItems(body.items)
      }
    } catch {
      // Best-effort
    } finally {
      setLoading(false)
    }
  }, [workspaceId, normalizedTargetType, targetId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const handleQuickStart = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !panelCtx || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: panelCtx.workspaceId,
          message: text,
          targetType: normalizedTargetType,
          targetId,
          visibility: "WORKSPACE",
          agentMode: "MENTION_ONLY",
        }),
      })
      if (res.ok) {
        setDraft("")
        const contentType = res.headers.get("content-type") ?? ""
        if (contentType.includes("application/json")) {
          const body = (await res.json()) as { conversationId?: string }
          await load()
          if (body.conversationId) {
            panelCtx.openConversationInPanel(body.conversationId, {
              label: text.slice(0, 60),
              targetType: normalizedTargetType,
              targetId,
              targetLabel: targetLabel ?? null,
              visibility: "WORKSPACE",
              agentMode: "MENTION_ONLY",
            })
          }
        } else {
          await load()
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="object-conversations-section">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Conversations
          </h3>
          {items.length > 0 && (
            <span className="rounded-full bg-surface-interactive px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-secondary">
              {items.length}
            </span>
          )}
        </div>
        {panelCtx && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="gap-1"
            onClick={() =>
              panelCtx.startNewConversationInPanel({
                targetType: normalizedTargetType,
                targetId,
                targetLabel: targetLabel ?? null,
                visibility: "WORKSPACE",
                agentMode: "MENTION_ONLY",
              })
            }
          >
            <Plus className="size-3" aria-hidden="true" />
            New conversation
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-text-subtle">Loading conversations…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-text-subtle">
          No conversations on this item yet. Start a thread with teammates or mention{" "}
          <span className="font-medium text-text-secondary">@Compass Agent</span> to pull in AI.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() =>
                  panelCtx?.openConversationInPanel(item.id, {
                    label: item.title,
                    targetType: normalizedTargetType,
                    targetId,
                    targetLabel: targetLabel ?? null,
                    visibility: item.visibility,
                    agentMode: item.agentMode,
                  })
                }
                className="group flex w-full min-w-0 flex-col gap-1 rounded-lg border border-default bg-surface-card p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-interactive/40"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <MessageSquare className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <span className="truncate text-sm font-medium text-text-primary">
                      {item.title}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
                    {item.status === "RESOLVED" ? (
                      <span className="inline-flex items-center gap-1 rounded bg-status-success-surface px-1.5 py-0.5 font-medium text-status-success">
                        <CheckCircle2 className="size-3" aria-hidden="true" />
                        Resolved
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-surface-inset px-1.5 py-0.5 text-text-subtle">
                        {item.agentMode === "AUTO" ? (
                          <>
                            <Bot className="size-3 text-primary" aria-hidden="true" />
                            Auto
                          </>
                        ) : (
                          <>
                            <AtSign className="size-3" aria-hidden="true" />
                            @mention
                          </>
                        )}
                      </span>
                    )}
                    <span className="tabular-nums text-text-subtle">
                      {item.messageCount} {item.messageCount === 1 ? "msg" : "msgs"}
                    </span>
                    <span className="text-text-subtle" suppressHydrationWarning>
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </div>
                </div>
                {item.summary && (
                  <p className="truncate pl-5 text-xs text-text-subtle">{item.summary}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {panelCtx && (
        <form onSubmit={(e) => void handleQuickStart(e)} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Start a conversation… (use @Compass Agent to include AI)"
              className="h-8 min-w-0 flex-1 rounded-lg border border-default bg-surface-card px-3 text-xs text-text-primary placeholder:text-text-subtle focus-visible:border-border-focus focus-visible:outline-none"
            />
            <button
              type="button"
              onClick={() =>
                setDraft((prev) =>
                  prev.includes("@Compass Agent") ? prev : `@Compass Agent ${prev.trimStart()}`,
                )
              }
              title="Mention @Compass Agent"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2.5 text-xs font-medium text-primary hover:bg-primary/15"
            >
              <AtSign className="size-3" aria-hidden="true" />
              <span>Agent</span>
            </button>
            <Button
              type="submit"
              size="sm"
              disabled={!draft.trim() || submitting}
              className="h-8 gap-1 px-3 text-xs"
            >
              <Send className="size-3" aria-hidden="true" />
              Send
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
