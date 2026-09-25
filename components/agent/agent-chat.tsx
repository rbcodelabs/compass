"use client"

// Agent chat surface (ADR 0001, Phase 4). Consumes the SSE stream from
// POST /api/agent/turn (the Phase 3 turn service) and renders a conversation.
//
// Conversation selection is server-driven via the `?c=<id>` search param (the
// page server-loads that conversation's messages), so this component only owns
// the active thread + composer + live streaming of the current turn.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Check, Loader2, Plus, Send, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { parseSseFrames } from "@/lib/sse-frames"
import { humanizeToolName } from "@/lib/agent-tools"
import { Markdown } from "@/components/agent/markdown"
import { SeedContextChip } from "@/components/agent/seed-context-chip"

type Role = "user" | "assistant"
type ToolStep = { id: string; label: string; status: "running" | "done" }
type Message = { id: string; role: Role; content: string; toolCalls?: ToolStep[] }
type ConversationSummary = { id: string; title: string | null }
type SeedEntity = { entityType: string; entityId: string; label: string; summary: string; sourceUrl: string }

type Props = {
  workspaceId: string
  basePath: string // `/${orgSlug}/${workspaceSlug}`
  conversations: ConversationSummary[]
  activeConversationId: string | null
  initialMessages: Message[]
  userInitials: string
  /** "Send to agent" hand-off (lib/agent-context.ts) — only ever set for a brand-new chat. */
  seedEntity?: SeedEntity
  suggestedInstruction?: string
  /**
   * Which surface this chat is rendered on.
   *
   * `"page"` (the default, so every existing call site is unchanged) is the
   * full-width agent screen: it owns its own card chrome and shows the
   * conversation list as an inline left column.
   *
   * `"rail"` is the docked left rail. It drops both of those: the rail supplies
   * the surrounding chrome itself, and a 320–560px column has no room for a
   * 256px conversation list beside the thread — so the rail hosts the
   * new-chat/thread-switcher controls in its own header and this component
   * renders the thread and composer only.
   */
  variant?: "page" | "rail"
  /**
   * Called when turn 1 of a brand-new chat comes back with the id the server
   * assigned to it.
   *
   * The page does not need this: it learns the id from the `?c=<id>` it rewrites
   * the URL to. The rail has no URL to read — it owns the active thread in React
   * state — so this callback is the only way it finds out which conversation the
   * transcript on screen now belongs to. Without it, the next "new chat" click
   * would be indistinguishable from the current one and "expand to full page"
   * would open an empty thread.
   */
  onConversationCreated?: (conversationId: string) => void
}

type StreamPhase = "idle" | "booting" | "running"
type Processing = {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED"
  /** Absent from an older server response, which only ever meant PM_INTERVIEW. */
  kind?: "PM_INTERVIEW" | "RESEARCH_SYNTHESIS"
  interviewId?: string
  targetUrl?: string | null
  canContinue?: boolean
  receipt: { changedFields: string[]; targetUrl: string; before?: Record<string, unknown>; after?: Record<string, unknown> } | null
}

export function AgentChat({
  workspaceId,
  basePath,
  conversations,
  activeConversationId,
  initialMessages,
  userInitials,
  seedEntity,
  suggestedInstruction,
  variant = "page",
  onConversationCreated,
}: Props) {
  const isRail = variant === "rail"
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  // Prefilled (editable) composer instruction from a "Send to agent" hand-off
  // — only for a brand-new chat. Lazy initializer so this never overwrites
  // composer text when resuming a past conversation (activeConversationId set).
  const [input, setInput] = useState(() => (!activeConversationId ? (suggestedInstruction ?? "") : ""))
  // The hand-off's context chip. Cleared on dismiss (composer text untouched)
  // and cleared the moment its seedContext is sent on the first turn, so it's
  // never resent — belt-and-suspenders alongside the server's own
  // conversationId-presence guard (app/api/agent/turn/route.ts).
  const [pendingSeedEntity, setPendingSeedEntity] = useState<SeedEntity | undefined>(seedEntity)
  const [phase, setPhase] = useState<StreamPhase>("idle")
  const [streamingText, setStreamingText] = useState("")
  const [liveToolSteps, setLiveToolSteps] = useState<ToolStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [processing, setProcessing] = useState<Processing | null>(null)
  const [processingLoading, setProcessingLoading] = useState(Boolean(activeConversationId))
  const started = useRef(new Set<string>())
  const sending = useRef(false)
  const streamController = useRef<AbortController | null>(null)
  // Kept in a ref so a parent passing an inline arrow can't change `send`'s
  // identity on every render — `send` is what the handoff auto-dispatch effect
  // reads through `sendRef`, and churning it there is how you get a double
  // dispatch.
  const onConversationCreatedRef = useRef(onConversationCreated)
  useEffect(() => {
    onConversationCreatedRef.current = onConversationCreated
  }, [onConversationCreated])
  // Conversations *this* component created, awaiting one re-seed skip each. See
  // the re-seed effect below for what that is protecting.
  const selfCreated = useRef(new Set<string>())

  const isStreaming = phase !== "idle"
  const composerBlocked = processingLoading || Boolean(processing && (!processing.canContinue || processing.status === "RUNNING" || processing.status === "PENDING"))

  useEffect(() => () => {
    streamController.current?.abort()
    sending.current = false
  }, [activeConversationId])

  // Re-seed the transcript whenever the selected conversation changes — with one
  // exception, consumed exactly once.
  //
  // Turn 1 of a new chat ends with the server's new conversation id being
  // adopted, which changes `activeConversationId` from null to that id. On the
  // page that arrives together with the server-loaded transcript, so re-seeding
  // is a no-op swap of identical content. The rail has no server render to
  // piggyback on: it adopts the id in place and deliberately does *not* refetch
  // messages it already has on screen, so `initialMessages` is still the empty
  // array the chat started with — and re-seeding from it would erase the turn
  // the user just watched stream in.
  //
  // The flag is removed as it is used, which is the part that matters. Leaving
  // it set would mean that switching to another thread and back to this one
  // skipped the re-seed a second time, leaving the *other* thread's messages on
  // screen under this thread's id.
  useEffect(() => {
    if (activeConversationId && selfCreated.current.has(activeConversationId)) {
      selfCreated.current.delete(activeConversationId)
      return
    }
    setMessages(initialMessages)
    setStreamingText("")
    setLiveToolSteps([])
    setError(null)
    setPhase("idle")
  }, [activeConversationId, initialMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, streamingText, liveToolSteps, phase])

  // `handoffKind` is passed in rather than read from `processing` because the
  // auto-dispatch below fires from the same tick as its `setProcessing`, so this
  // closure would still see the previous value. Optimistic text only: the server
  // replaces a claimed turn's message with the registered per-kind instruction
  // (lib/agent-handoff-kinds.ts).
  const send = useCallback(async (handoff = false, retry = false, handoffKind?: Processing["kind"]) => {
    const text = handoff
      ? handoffKind === "RESEARCH_SYNTHESIS" ? "Synthesize my saved research for this study." : "Use my saved interview to update the item."
      : input.trim()
    if (!text || sending.current) return
    sending.current = true
    const controller = new AbortController()
    streamController.current = controller
    setInput("")
    setError(null)
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: text }])
    setPhase("booting")
    setStreamingText("")
    setLiveToolSteps([])

    // Only turn 1 of a brand-new conversation carries seedContext — never a
    // resumed thread. Clear it immediately so a second send() in this same
    // session (before the server round-trip updates activeConversationId)
    // can't resend it.
    const seedContextForThisTurn =
      !activeConversationId && pendingSeedEntity
        ? { entityType: pendingSeedEntity.entityType, entityId: pendingSeedEntity.entityId }
        : undefined
    if (seedContextForThisTurn) setPendingSeedEntity(undefined)

    let assembled = ""
    let steps: ToolStep[] = []
    let newConversationId: string | null = null
    try {
      const res = await fetch("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId,
          message: text,
          conversationId: activeConversationId ?? undefined,
          ...(seedContextForThisTurn ? { seedContext: seedContextForThisTurn } : {}),
          ...(retry ? { retry: true } : {}),
          ...(!handoff && processing?.canContinue ? { continue: true } : {}),
        }),
      })
      if (controller.signal.aborted) return
      if (!res.ok || !res.body) {
        const serverMsg = await res.text().catch(() => "")
        throw new Error(
          res.status === 401
            ? "Your session expired — reload and sign in."
            : serverMsg || `Request failed (${res.status}).`
        )
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (controller.signal.aborted) return
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = parseSseFrames(buffer)
        buffer = rest
        for (const { event, data } of frames) {
          let payload: unknown
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          const p = payload as Record<string, unknown>
          if (event === "status") {
            setPhase(p.phase === "running" ? "running" : "booting")
            if (typeof p.conversationId === "string") newConversationId = p.conversationId
          } else if (event === "agent") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sdk = (p.message ?? {}) as any
            const content = sdk?.message?.content
            if (Array.isArray(content)) {
              for (const block of content as Record<string, unknown>[]) {
                if (block.type === "text" && typeof block.text === "string") {
                  assembled += block.text
                  setStreamingText(assembled)
                } else if (block.type === "tool_use" && typeof block.name === "string") {
                  steps = [...steps, { id: String(block.id ?? steps.length), label: humanizeToolName(block.name), status: "running" }]
                  setLiveToolSteps(steps)
                } else if (block.type === "tool_result") {
                  const tid = String(block.tool_use_id ?? "")
                  steps = steps.map((s) => (s.id === tid ? { ...s, status: "done" } : s))
                  setLiveToolSteps(steps)
                }
              }
            }
          } else if (event === "result") {
            if (typeof p.text === "string" && p.text) assembled = p.text
            if (typeof p.conversationId === "string") newConversationId = p.conversationId
          } else if (event === "error") {
            throw new Error(typeof p.message === "string" ? p.message : "The agent hit an error.")
          }
        }
      }

      const finalSteps = steps.map((s) => ({ ...s, status: "done" as const }))
      setMessages((m) => [
        ...m,
        { id: `a-${Date.now()}`, role: "assistant", content: assembled || "(no response)", toolCalls: finalSteps },
      ])
      setStreamingText("")
      setLiveToolSteps([])
      setPhase("idle")
      const createdId = newConversationId && newConversationId !== activeConversationId ? newConversationId : null
      if (createdId) {
        selfCreated.current.add(createdId)
        onConversationCreatedRef.current?.(createdId)
      }
      // Both router calls are page-only, and for the same underlying reason: the
      // page *is* the route, so re-rendering it is how its server-loaded
      // conversation list and `?c=` selection stay true. The rail is mounted in
      // the workspace layout, above whichever route the user happens to be on.
      // `router.replace` from there would navigate them to the agent screen
      // mid-stream — the precise interruption the rail exists to remove — and
      // `router.refresh()` would re-render a screen they are reading to refresh
      // data the rail does not consume. The rail keeps its own list current by
      // refetching it (see AgentRail), which costs one query instead of a
      // whole route.
      if (!isRail) {
        if (createdId) router.replace(`${basePath}/agent?c=${createdId}`)
        router.refresh()
      }
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : "Something went wrong.")
      setStreamingText("")
      setLiveToolSteps([])
      setPhase("idle")
    } finally {
      if (streamController.current === controller) sending.current = false
    }
  }, [input, workspaceId, activeConversationId, basePath, router, isRail, processing?.canContinue, pendingSeedEntity])

  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send }, [send])
  useEffect(() => {
    setProcessing(null)
    setProcessingLoading(Boolean(activeConversationId))
    if (!activeConversationId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refreshProcessing() {
      try {
        const response = await fetch(`/api/agent/conversations/${activeConversationId}/processing?workspaceId=${encodeURIComponent(workspaceId)}`)
        if (cancelled) return
        if (response.status === 404) { setProcessingLoading(false); return }
        if (!response.ok) throw new Error("Unable to check processing status. Reload before retrying.")
        const state = await response.json() as Processing
        if (cancelled) return
        setProcessing(state)
        setProcessingLoading(false)
        if (state.status === "PENDING" && !started.current.has(activeConversationId!)) {
          started.current.add(activeConversationId!)
          void sendRef.current(true, false, state.kind)
        }
        if (state.status === "PENDING" || state.status === "RUNNING") timer = setTimeout(() => void refreshProcessing(), 2000)
      } catch (caught) {
        if (!cancelled) { setError(caught instanceof Error ? caught.message : "Unable to check processing status."); timer = setTimeout(() => void refreshProcessing(), 5000) }
      }
    }
    void refreshProcessing()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [activeConversationId, workspaceId, phase])

  const phaseLabel = useMemo(() => {
    if (phase === "booting") return "Starting the agent…"
    if (phase === "running" && !streamingText && liveToolSteps.length === 0) return "Thinking…"
    return null
  }, [phase, streamingText, liveToolSteps.length])

  return (
    <div
      className={`flex min-h-0 flex-1 overflow-hidden bg-surface-panel ${
        // The rail draws its own border and header, so a second rounded card
        // inside it would read as a box in a box.
        isRail ? "" : "rounded-xl border border-default"
      }`}
    >
      {/* Conversation list — page only; in the rail these controls live in the
          rail header instead, because 256px of list plus a readable thread does
          not fit in a 320–560px column. */}
      {!isRail && (
      <aside className="hidden w-64 shrink-0 flex-col border-r border-default bg-surface-inset md:flex">
        <div className="p-3">
          <Button variant="outline" size="sm" className="w-full justify-start gap-2" render={<Link href={`${basePath}/agent`} />}>
            <Plus className="size-4" aria-hidden="true" />
            New chat
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          <ul className="flex flex-col gap-1">
            {conversations.length === 0 && (
              <li className="px-2 py-6 text-center text-sm text-text-subtle">No conversations yet</li>
            )}
            {conversations.map((c) => {
              const active = c.id === activeConversationId
              return (
                <li key={c.id}>
                  <Link
                    href={`${basePath}/agent?c=${c.id}`}
                    className={`block truncate rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-surface-interactive text-text-primary"
                        : "text-text-secondary hover:bg-surface-interactive-hover hover:text-text-primary"
                    }`}
                  >
                    {c.title || "Untitled chat"}
                  </Link>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </aside>
      )}

      {/* Thread + composer.
          min-w-0 is load-bearing: as a flex item this column defaults to
          min-width:auto, so it refuses to shrink below its content's
          min-content width. The seed context chip's summary line is
          `truncate` (white-space:nowrap), whose min-content width is the
          full untruncated string — that propagated up and inflated this
          column past the viewport inside the overflow-hidden root, pushing
          the Send button and the chip's own dismiss control off-screen on
          any width below ~1000px. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          {/* `sm:p-6` is dropped in the rail: the breakpoint tracks the
              viewport, not this column, so a 360px rail on a wide screen would
              otherwise spend 48px of its width on padding. */}
          <div className={`mx-auto flex w-full max-w-3xl flex-col gap-4 ${isRail ? "p-3" : "p-4 sm:p-6"}`}>
            {processing && (processing.kind === "RESEARCH_SYNTHESIS"
              // ADR-0012 step 4. This handoff has no target item and no field
              // receipt — its durable artifact is the ResearchSynthesis snapshot
              // on the study page, so the PM panel's copy and links do not apply.
              ? <section aria-live="polite" className="space-y-2 rounded-lg border p-4 text-sm">
                {/* "Turn finished" rather than "Synthesis stored": the claim is
                    marked SUCCEEDED whenever the turn completes without throwing,
                    which does not by itself prove the agent called the storage
                    tool or that its citations passed validation. The study page
                    is the authority on whether a snapshot exists. */}
                <p className="font-medium">{processing.status === "SUCCEEDED" ? "Synthesis turn finished" : processing.status === "RUNNING" || processing.status === "PENDING" ? "Synthesizing your saved research…" : "The synthesis did not finish"}</p>
                <p>Your saved research is unchanged. {processing.status === "SUCCEEDED" ? "Check the study page for the stored snapshot, and read the agent’s reply above for what it found." : "Follow the agent’s progress here."}</p>
                {processing.targetUrl && <Link className="block underline" href={processing.targetUrl}>View study and synthesis history</Link>}
                {(processing.status === "FAILED" || processing.status === "INTERRUPTED") && <Button disabled={isStreaming} onClick={() => void send(true, true, processing.kind)}>Retry synthesis</Button>}
              </section>
              : <section aria-live="polite" className="space-y-2 rounded-lg border p-4 text-sm">
                <p className="font-medium">{processing.receipt ? (processing.receipt.changedFields.length ? "Item updated" : "No changes saved") : processing.status === "RUNNING" || processing.status === "PENDING" ? "Updating your item…" : "The update did not finish"}</p>
                {processing.receipt ? <><dl className="space-y-3">{processing.receipt.changedFields.map(field => <div key={field}><dt className="font-medium">{field}</dt>{processing.receipt?.before && processing.receipt?.after && <dd className="grid gap-2 sm:grid-cols-2"><div><span className="text-text-subtle">Before</span><p className="whitespace-pre-wrap">{String(processing.receipt.before[field] ?? "empty")}</p></div><div><span className="text-text-subtle">After</span><p className="whitespace-pre-wrap">{String(processing.receipt.after[field] ?? "empty")}</p></div></dd>}</div>)}</dl><Link className="underline" href={processing.receipt.targetUrl}>Open updated item</Link></> : <p>Your transcript is saved. {processing.status === "RUNNING" ? "An update is already running; no additional request is needed." : "Follow the agent’s progress here."}</p>}
                <Link className="block underline" href={`${basePath}/capture/pm/${processing.interviewId}`}>View saved interview</Link>
                {!processing.receipt && (processing.status === "FAILED" || processing.status === "INTERRUPTED") && <Button disabled={isStreaming} onClick={() => void send(true, true)}>Retry update</Button>}
              </section>)}
            {messages.length === 0 && !isStreaming && !processing && !processingLoading && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-surface-interactive text-text-secondary">
                  <Sparkles className="size-6" aria-hidden="true" />
                </div>
                <p className="text-base font-medium text-text-primary">Ask the Compass agent</p>
                <p className="max-w-sm text-sm text-text-subtle">
                  It can read and update this workspace&apos;s opportunities, experiments, roadmap, OKRs, and more —
                  scoped to what you can access.
                </p>
              </div>
            )}

            {messages.map((m) => (
              <MessageRow key={m.id} message={m} userInitials={userInitials} />
            ))}

            {isStreaming && (
              <MessageRow
                message={{ id: "streaming", role: "assistant", content: streamingText, toolCalls: liveToolSteps }}
                userInitials={userInitials}
                phaseLabel={phaseLabel}
              />
            )}

            {error && (
              <div className="rounded-lg border border-default bg-status-danger-surface px-4 py-3 text-sm text-status-danger">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        <div className={`border-t border-default bg-surface-panel ${isRail ? "p-3" : "p-3 sm:p-4"}`}>
          {pendingSeedEntity && (
            <div className="mb-2">
              <SeedContextChip
                label={pendingSeedEntity.label}
                summary={pendingSeedEntity.summary}
                sourceUrl={pendingSeedEntity.sourceUrl}
                onDismiss={() => setPendingSeedEntity(undefined)}
              />
            </div>
          )}
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
              rows={1}
              disabled={isStreaming || composerBlocked}
              className="max-h-40 flex-1"
            />
            <Button size="icon" onClick={() => void send()} disabled={isStreaming || composerBlocked || !input.trim()} aria-label="Send message">
              <Send className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolSteps({ steps }: { steps: ToolStep[] }) {
  if (steps.length === 0) return null
  return (
    <ul className="mb-2 flex flex-col gap-1 border-b border-default pb-2">
      {steps.map((s) => (
        <li key={s.id} className="flex items-center gap-1.5 text-xs text-text-subtle">
          {s.status === "running" ? (
            <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="size-3 shrink-0 text-status-success" aria-hidden="true" />
          )}
          <span className="truncate">{s.label}</span>
        </li>
      ))}
    </ul>
  )
}

function MessageRow({
  message,
  userInitials,
  phaseLabel,
}: {
  message: Message
  userInitials: string
  phaseLabel?: string | null
}) {
  const isUser = message.role === "user"
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <Avatar className="size-7 shrink-0">
        <AvatarFallback className={isUser ? "bg-surface-interactive text-text-secondary" : "bg-primary text-primary-foreground"}>
          {isUser ? userInitials : <Sparkles className="size-4" aria-hidden="true" />}
        </AvatarFallback>
      </Avatar>
      <div
        className={`min-w-0 max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
          isUser ? "bg-primary text-primary-foreground" : "border border-default bg-surface-card text-text-primary"
        }`}
      >
        {!isUser && message.toolCalls && <ToolSteps steps={message.toolCalls} />}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : message.content ? (
          <Markdown>{message.content}</Markdown>
        ) : phaseLabel ? (
          <p className="flex items-center gap-1.5 text-text-subtle">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {phaseLabel}
          </p>
        ) : (
          <p className="text-text-subtle">…</p>
        )}
      </div>
    </div>
  )
}
