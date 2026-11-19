"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Archive, AtSign, Bot, CheckCircle2, MessageSquare, Plus, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MentionEditor, type MentionOptions } from "@/components/docs/mention-editor"
import { useConversationPanelOptional } from "@/components/panels/conversation-panel"
import type { ObjectConversationSummary } from "@/app/api/agent/conversations/by-target/route"
import { formatRelativeTime } from "@/lib/agent-board"
import { plainTextOf, serializeMention } from "@/lib/comment-mentions"
import { CONVERSATION_ARCHIVE_CHANGED_EVENT, type ConversationArchiveChange } from "@/components/conversations/archive-events"
import { removeObjectConversationLink } from "@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions"

const BUILTIN_COMPASS_AGENT_ID = "00000000-0000-4000-8000-000000000001"

async function acceptedConversationId(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type") ?? ""
  if (type.includes("application/json")) {
    const body = await response.json() as { conversationId?: unknown }
    return typeof body?.conversationId === "string" && body.conversationId ? body.conversationId : null
  }
  // The older streaming turn acknowledges persistence in its booting event.
  if (!type.includes("text/event-stream") || !response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let bytes = 0
  try {
    while (bytes < 65_536) {
      const { done, value } = await reader.read()
      if (done) return null
      bytes += value.byteLength
      if (bytes > 65_536) return null
      buffered += decoder.decode(value, { stream: true })
      const frames = buffered.split(/\r?\n\r?\n/)
      buffered = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
        if (!data) continue
        const body = JSON.parse(data) as { conversationId?: unknown }
        if (typeof body?.conversationId === "string" && body.conversationId) return body.conversationId
      }
    }
    return null
  } finally {
    reader.releaseLock()
  }
}

const DEFAULT_MENTION_OPTIONS: MentionOptions = {
  people: [],
  agents: [
    {
      kind: "agent",
      id: BUILTIN_COMPASS_AGENT_ID,
      name: "Compass Agent",
      detail: "Workspace AI assistant",
      access: "WRITE",
      agentKind: "CLOUD",
    },
  ],
  outside: [],
}

type Props = { targetType: string; targetId: string; targetLabel?: string | null }

export function ObjectConversationsSection(props: Props) {
  const panel = useConversationPanelOptional()
  return <ObjectConversationsContent key={`${panel?.workspaceId}:${props.targetType}:${props.targetId}`} {...props} />
}

function ObjectConversationsContent({
  targetType,
  targetId,
  targetLabel,
}: Props) {
  const panelCtx = useConversationPanelOptional()
  const workspaceId = panelCtx?.workspaceId
  const normalizedTargetType = targetType.toUpperCase()

  const [items, setItems] = useState<ObjectConversationSummary[]>([])
  const [mentionOptions, setMentionOptions] = useState<MentionOptions>(DEFAULT_MENTION_OPTIONS)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState("")
  const [editorKey, setEditorKey] = useState(0)
  const [autoFocusEditor, setAutoFocusEditor] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<"rejected" | "uncertain" | null>(null)
  const [status, setStatus] = useState("")
  const [confirmLink, setConfirmLink] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string[]>([])
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({})
  // Archive is the only way a conversation leaves the list, and it is reversible: "Show archived" swaps the list for the
  // archived threads this person may restore (the server decides; nothing else is ever returned).
  const [showArchived, setShowArchived] = useState(false)
  const [archivedCapped, setArchivedCapped] = useState(false)
  const [restoring, setRestoring] = useState<string[]>([])
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({})
  const mounted = useRef(false)
  const lifetime = useRef(0)
  const loadGeneration = useRef(0)
  const sendPending = useRef(false)
  const removalPending = useRef(new Set<string>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    mounted.current = true
    lifetime.current++
    return () => { mounted.current = false; lifetime.current++; loadGeneration.current++ }
  }, [])

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    const current = () => mounted.current && loadGeneration.current === generation
    if (!workspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const qs = new URLSearchParams({
        workspaceId,
        targetType: normalizedTargetType,
        targetId,
        ...(showArchived ? { archived: "1" } : {}),
      })
      const res = await fetch(`/api/agent/conversations/by-target?${qs.toString()}`)
      if (!res.ok) throw new Error("List request failed")
      const body = (await res.json()) as {
        items?: ObjectConversationSummary[]
        mentionOptions?: MentionOptions
        archivedCapped?: boolean
      }
      if (!Array.isArray(body.items)) throw new Error("Invalid list response")
      if (!current()) return
      setItems(body.items)
      setArchivedCapped(showArchived && body.archivedCapped === true)
      if (body.mentionOptions) {
        setMentionOptions(body.mentionOptions)
      }
    } catch {
      if (current()) setLoadError("Could not load conversations. Please try again.")
    } finally {
      if (current()) setLoading(false)
    }
  }, [workspaceId, normalizedTargetType, targetId, showArchived])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  // A conversation archived from the panel: drop its row at once (a refresh that started earlier must not bring it
  // back), say so, and put focus where the row was, on the section heading.
  const itemsRef = useRef<ObjectConversationSummary[]>([])
  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => {
    const onChange = (event: Event) => {
      const { conversationId, archived } = (event as CustomEvent<ConversationArchiveChange>).detail
      // Only this section's own rows are announced; another object's section ignores the event entirely.
      const listed = itemsRef.current.some((row) => row.id === conversationId)
      if (listed && archived !== showArchived) {
        // Archived from the live list, or restored from the archived list: the row leaves this view.
        loadGeneration.current++
        setLoading(false)
        setItems((previous) => previous.filter((row) => row.id !== conversationId))
        setStatus(archived ? "Conversation archived." : "Conversation restored.")
        headingRef.current?.focus()
      }
      if (listed || (showArchived && archived)) void load()
      else if (!showArchived && !archived) void load()
    }
    window.addEventListener(CONVERSATION_ARCHIVE_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(CONVERSATION_ARCHIVE_CHANGED_EVENT, onChange)
  }, [load, showArchived])

  async function restoreConversation(item: ObjectConversationSummary) {
    if (!workspaceId || restoring.includes(item.id)) return
    const generation = lifetime.current
    const current = () => mounted.current && lifetime.current === generation
    setRestoring((previous) => [...previous, item.id])
    setRestoreErrors((previous) => { const next = { ...previous }; delete next[item.id]; return next })
    try {
      const res = await fetch(`/api/agent/conversations/${item.id}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      })
      if (!current()) return
      if (!res.ok) throw new Error("restore failed")
      loadGeneration.current++
      setLoading(false)
      setItems((previous) => previous.filter((row) => row.id !== item.id))
      setStatus("Conversation restored.")
      headingRef.current?.focus()
    } catch {
      if (current()) setRestoreErrors((previous) => ({ ...previous, [item.id]: "We couldn’t restore this conversation. Please try again." }))
    } finally {
      if (current()) setRestoring((previous) => previous.filter((id) => id !== item.id))
    }
  }

  const submitQuickStart = useCallback(async () => {
    const text = draft
    if (!text.trim() || !panelCtx || sendPending.current) return
    sendPending.current = true
    const generation = lifetime.current
    const current = () => mounted.current && lifetime.current === generation
    setSubmitting(true)
    setSendError(null)
    setStatus("")
    let accepted = false
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
      if (!current()) return
      if (!res.ok) {
        setSendError(res.status >= 500 ? "uncertain" : "rejected")
        return
      }
      // A malformed acceptance cannot tell us which conversation received the
      // message. Keep the draft for deliberate recovery, never resend silently.
      const conversationId = await acceptedConversationId(res)
      if (!current()) return
      if (!conversationId) {
        setSendError("uncertain")
        return
      }
      if (current()) {
        accepted = true
        setDraft("")
        setAutoFocusEditor(false)
        setEditorKey((k) => k + 1)
        setStatus("Message sent.")
        await load()
        if (current()) {
          panelCtx.openConversationInPanel(conversationId, {
            label: plainTextOf(text).slice(0, 60),
            targetType: normalizedTargetType,
            targetId,
            targetLabel: targetLabel ?? null,
            visibility: "WORKSPACE",
            agentMode: "MENTION_ONLY",
          })
        }
      }
    } catch {
      if (current() && !accepted) setSendError("uncertain")
    } finally {
      sendPending.current = false
      if (current()) setSubmitting(false)
    }
  }, [draft, panelCtx, submitting, normalizedTargetType, targetId, targetLabel, load])

  const handleQuickStart = (e: React.FormEvent) => {
    e.preventDefault()
    void submitQuickStart()
  }

  async function removeLink(item: ObjectConversationSummary, linkId: string) {
    if (!panelCtx || removalPending.current.has(item.id)) return
    removalPending.current.add(item.id)
    const generation = lifetime.current
    const current = () => mounted.current && lifetime.current === generation
    setRemoving(previous => [...previous, item.id])
    setRemoveErrors(previous => { const next = { ...previous }; delete next[linkId]; return next })
    try {
      const result = await removeObjectConversationLink(panelCtx.orgSlug, panelCtx.workspaceSlug, linkId)
      if (!current()) return
      if (!result.ok) throw new Error(result.error)
      if (!result.removed) {
        await load()
        if (current()) { setConfirmLink(null); setStatus("Conversations refreshed. Check the link before retrying."); headingRef.current?.focus() }
        return
      }
      // A refresh started before unlinking must not resurrect its stale link.
      loadGeneration.current++
      setLoading(false)
      setItems(previous => previous.flatMap(row => {
        if (row.id !== item.id) return [row]
        const links = row.links.filter(link => link.linkId !== linkId)
        return row.anchored || links.length ? [{ ...row, links }] : []
      }))
      setConfirmLink(null)
      setStatus("Link removed. Conversation kept.")
      headingRef.current?.focus()
      await load()
    } catch {
      if (current()) setRemoveErrors(previous => ({ ...previous, [linkId]: "Could not remove the link. Please try again." }))
    } finally {
      removalPending.current.delete(item.id)
      if (current()) setRemoving(previous => previous.filter(id => id !== item.id))
    }
  }

  const handleInsertAgentMention = () => {
    if (sendPending.current) return
    const agentOpt = mentionOptions.agents[0] ?? DEFAULT_MENTION_OPTIONS.agents[0]!
    const token = serializeMention({
      kind: "agent",
      id: agentOpt.id,
      label: agentOpt.name,
    })
    setDraft((prev) => {
      if (prev.includes(`mention:agent:${agentOpt.id}`) || prev.includes("@Compass Agent")) {
        return prev
      }
      return prev.trim() ? `${token} ${prev.trimStart()}` : `${token} `
    })
    setAutoFocusEditor(true)
    setEditorKey((k) => k + 1)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="object-conversations-section">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Conversations
          </h3>
          {items.length > 0 && (
            <span className="rounded-full bg-surface-interactive px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-secondary">
              {items.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={showArchived ? "secondary" : "ghost"}
            size="xs"
            className="gap-1"
            aria-pressed={showArchived}
            onClick={() => {
              loadGeneration.current++
              setItems([])
              setLoadError(null)
              setStatus("")
              setShowArchived((value) => !value)
            }}
          >
            <Archive className="size-3" aria-hidden="true" />
            Show archived
          </Button>
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
      </div>

      {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-status-danger/30 bg-status-danger-surface p-3 text-sm text-status-danger">
        <p>{loadError}{items.length > 0 && " Showing the last loaded list."}</p>
        <Button type="button" variant="outline" size="xs" disabled={loading} onClick={() => void load()}>Retry</Button>
      </div>}
      {loading && items.length === 0 ? (
        <p className="text-xs text-text-subtle">Loading conversations…</p>
      ) : items.length === 0 && !loadError ? (
        showArchived ? (
          <p className="text-xs text-text-subtle">No archived conversations that you can restore.</p>
        ) : (
        <p className="text-xs text-text-subtle">
          No conversations on this item yet. Start a thread with teammates or mention{" "}
          <span className="font-medium text-text-secondary">@Compass Agent</span> to pull in AI.
        </p>
        )
      ) : (
        <>
        {showArchived && archivedCapped && <p className="text-xs text-text-subtle">Showing the 50 most recent archived conversations.</p>}
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
                    {item.archived && <span className="sr-only">Archived. </span>}
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
              {item.canRestore && (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-text-subtle">
                  <span>Archived</span>
                  <Button type="button" variant="outline" size="xs" disabled={restoring.includes(item.id)} onClick={() => void restoreConversation(item)}>
                    Restore
                  </Button>
                  {restoreErrors[item.id] && <p role="alert" className="basis-full text-status-danger">{restoreErrors[item.id]}</p>}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-text-subtle">
                {item.anchored && <span>On this item</span>}
                {item.links?.map(link => <div key={link.linkId} className="flex flex-wrap items-center gap-2">
                  <span>{link.kind === "CREATED" ? "Created here" : "Mentioned"}</span>
                  {link.auto && <Button ref={element => { if (element) removeButtonRefs.current.set(link.linkId, element); else removeButtonRefs.current.delete(link.linkId) }} type="button" variant="ghost" size="xs" disabled={removing.includes(item.id)} aria-label={`Remove ${link.kind === "CREATED" ? "Created here" : "Mentioned"} link to ${item.title}`} onClick={() => setConfirmLink(link.linkId)}>Remove link</Button>}
                  {confirmLink === link.linkId && <div className="basis-full rounded-lg border border-border-default p-3 text-sm text-text-primary">
                    <p>Remove this link?</p><p>The conversation and this item will be kept.</p>
                    <div className="mt-2 flex gap-2">
                      <Button type="button" variant="outline" size="xs" disabled={removing.includes(item.id)} onClick={() => { setConfirmLink(null); removeButtonRefs.current.get(link.linkId)?.focus() }}>Cancel</Button>
                      <Button type="button" variant="outline" size="xs" disabled={removing.includes(item.id)} onClick={() => void removeLink(item, link.linkId)}>{removing.includes(item.id) ? "Removing…" : "Remove link"}</Button>
                    </div>
                  </div>}
                  {removeErrors[link.linkId] && <div role="alert" className="basis-full text-status-danger"><p>{removeErrors[link.linkId]}</p><Button type="button" variant="outline" size="xs" disabled={removing.includes(item.id)} onClick={() => void removeLink(item, link.linkId)}>Retry removal</Button></div>}
                </div>)}
              </div>
            </li>
          ))}
        </ul>
        </>
      )}

      {panelCtx && (
        <form onSubmit={handleQuickStart} className="flex flex-col gap-2">
          {sendError && <div role="alert" className="rounded-lg border border-status-danger/30 bg-status-danger-surface p-3 text-sm text-status-danger">
            <p>{sendError === "uncertain" ? "We couldn’t confirm whether this was sent. Check conversations before retrying." : "Could not send your message. Your draft is kept."}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {sendError === "uncertain" && <Button type="button" variant="outline" size="xs" disabled={loading} onClick={() => void load()}>Refresh conversations</Button>}
              <Button type="button" variant="outline" size="xs" disabled={submitting || !draft.trim()} onClick={() => void submitQuickStart()}>Retry send</Button>
            </div>
          </div>}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <MentionEditor
                key={editorKey}
                options={mentionOptions}
                initialValue={draft}
                ariaLabel="Start a conversation"
                placeholder="Start a conversation… (type @ to mention people or agents)"
                onChange={setDraft}
                onSubmitShortcut={() => void submitQuickStart()}
                submitOnEnter
                autoFocus={autoFocusEditor}
                disabled={submitting}
                className="min-h-8 rounded-lg border-default bg-surface-card px-3 py-1.5 text-xs focus-visible:border-border-focus"
                testId="object-conversation-composer"
              />
            </div>
            <button
              type="button"
              onClick={handleInsertAgentMention}
              disabled={submitting}
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
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      )}
      <p role="status" className="text-xs text-text-secondary">{status}</p>
    </div>
  )
}
