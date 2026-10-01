"use client"

// Agent chat surface (ADR 0001, Phase 4).
//
// Conversation selection is server-driven via the `?c=<id>` search param (the
// page server-loads that conversation's messages), so this component only owns
// the active thread + composer + live streaming of the current turn.
//
// Two transports, because the server has two paths (see app/api/agent/turn):
//
//   * `202 { runId }` — the turn is a *detached run*. The agent is no longer
//     attached to the POST at all: this component becomes a viewer that tails
//     /api/agent/runs/:runId/stream, can be closed and reopened, and reattaches
//     on mount via /api/agent/conversations/:id/run. Closing the tab no longer
//     abandons the turn, which is the whole point of detached runs.
//   * `text/event-stream` — the pre-migration fallback, where the turn lives and
//     dies with this request exactly as it used to.
//
// Both reduce through lib/agent-run-stream.ts so the two views of one turn cannot
// drift apart.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Check, Loader2, Plus, Send, Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { parseSseFrames } from "@/lib/sse-frames"
import {
  applyAgentSdkEvent,
  emptyAgentTurnState,
  runFailureText,
  settleSteps,
  type AgentTurnState,
  type SerializedRun,
  type ToolStep,
} from "@/lib/agent-run-stream"
import { Markdown } from "@/components/agent/markdown"
import { SeedContextChip } from "@/components/agent/seed-context-chip"

type Role = "user" | "assistant"
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
  /**
   * Called whenever a turn starts or stops streaming.
   *
   * The rail needs it because closing the rail unmounts this component, which
   * aborts the turn: it uses it to keep Esc and "expand to full page" from
   * doing that implicitly mid-turn. The page does not pass it.
   */
  onStreamingChange?: (streaming: boolean) => void
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
  onStreamingChange,
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
  /** The detached run this tab is currently viewing, if any. */
  const [activeRun, setActiveRun] = useState<SerializedRun | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [processing, setProcessing] = useState<Processing | null>(null)
  const [processingLoading, setProcessingLoading] = useState(Boolean(activeConversationId))
  const started = useRef(new Set<string>())
  const sending = useRef(false)
  const streamController = useRef<AbortController | null>(null)
  /**
   * Aborts the *viewer* of a detached run — never the run itself, which lives in
   * a sandbox and is stopped only by DELETE or by the sweeper.
   */
  const runController = useRef<AbortController | null>(null)
  /**
   * Runs with a live reader in this tab. The tab that started a run is already
   * watching it, so the reattach effect must not open a second reader that
   * replays the same events into the same transcript.
   */
  const watchedRuns = useRef(new Set<string>())
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

  // Through a ref for the same reason as onConversationCreated: an inline arrow
  // from the parent must not re-fire this on every render, only on a change.
  const onStreamingChangeRef = useRef(onStreamingChange)
  useEffect(() => {
    onStreamingChangeRef.current = onStreamingChange
  }, [onStreamingChange])
  useEffect(() => {
    onStreamingChangeRef.current?.(isStreaming)
  }, [isStreaming])
  const composerBlocked = processingLoading || Boolean(processing && (!processing.canContinue || processing.status === "RUNNING" || processing.status === "PENDING"))

  // Unmount only — deliberately NOT keyed on `activeConversationId`.
  //
  // Turn 1 of a brand-new chat adopts the server's conversation id while its run
  // is still going, so a cleanup keyed on that id would hang up on the run it had
  // just started. A genuine thread switch aborts in the re-seed effect below,
  // which is the one place that can tell adoption and switching apart.
  useEffect(() => () => {
    streamController.current?.abort()
    runController.current?.abort()
    sending.current = false
  }, [])

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
    // A real thread switch: stop reading the previous thread's run. The run keeps
    // going server-side, and coming back to that thread reattaches to it.
    streamController.current?.abort()
    runController.current?.abort()
    runController.current = null
    sending.current = false
    setActiveRun(null)
    setMessages(initialMessages)
    setStreamingText("")
    setLiveToolSteps([])
    setError(null)
    setPhase("idle")
  }, [activeConversationId, initialMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, streamingText, liveToolSteps, phase])

  /**
   * View a detached run to completion.
   *
   * Everything here is a *read*: the SSE tail and the snapshot route both only
   * query rows the sandbox writes, so this can be started, abandoned and started
   * again — on a different day, in a different tab — and it converges on the same
   * transcript. That is why the fallbacks below are allowed to be as blunt as
   * "start over from `afterSeq`".
   */
  const watchRun = useCallback(async (runId: string, controller: AbortController) => {
    if (watchedRuns.current.has(runId)) return
    watchedRuns.current.add(runId)

    let turn: AgentTurnState = emptyAgentTurnState
    let afterSeq = 0
    let run: SerializedRun | null = null
    let resultText: string | null = null
    let reportedFailure: string | null = null
    let consecutiveFailures = 0

    const apply = (next: AgentTurnState) => {
      if (next === turn) return
      turn = next
      setStreamingText(turn.text)
      setLiveToolSteps(turn.steps)
    }
    const ingest = (event: { seq: number; type: string; payload: unknown }) => {
      // Monotonic, and never trusted to arrive in order: `afterSeq` is the cursor
      // every resume is built on, so moving it backwards would replay events.
      if (event.seq > afterSeq) afterSeq = event.seq
      const payload = (event.payload ?? {}) as Record<string, unknown>
      if (event.type === "agent") apply(applyAgentSdkEvent(event.payload, turn))
      else if (event.type === "status") setPhase(payload.phase === "running" ? "running" : "booting")
      else if (event.type === "result") { if (typeof payload.text === "string") resultText = payload.text }
      else if (event.type === "error") reportedFailure = typeof payload.message === "string" ? payload.message : "The agent hit an error."
    }
    const adoptRun = (next: SerializedRun) => {
      run = next
      setActiveRun(next)
      if (!next.done) setPhase(next.status === "QUEUED" ? "booting" : "running")
    }
    /** Polling fallback for when the tail is unavailable but the run is fine. */
    const snapshot = async (): Promise<SerializedRun | null> => {
      let latest: SerializedRun | null = null
      for (let page = 0; page < 20; page += 1) {
        const res = await fetch(`/api/agent/runs/${runId}?afterSeq=${afterSeq}`, { signal: controller.signal })
        if (!res.ok) return latest
        const body = await res.json() as { run: SerializedRun; events: { seq: number; type: string; payload: unknown }[]; hasMore: boolean }
        for (const event of body.events) ingest(event)
        latest = body.run
        if (!body.hasMore) break
      }
      return latest
    }

    try {
      for (;;) {
        if (controller.signal.aborted) return
        try {
          const res = await fetch(`/api/agent/runs/${runId}/stream?afterSeq=${afterSeq}`, {
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          })
          if (res.status === 404) throw new Error("This run is no longer available.")
          if (!res.ok || !res.body) throw new Error(`Run stream failed (${res.status}).`)
          consecutiveFailures = 0
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          let finished = false
          let hungUp = false
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
              if (event === "run") adoptRun(payload as SerializedRun)
              else if (event === "event") ingest(payload as { seq: number; type: string; payload: unknown })
              else if (event === "done") finished = true
              // `reconnect` is the server hanging up before its function times
              // out, and `error` is its tail failing — both mean "ask again from
              // afterSeq", which is what falling out of this loop does.
              else if (event === "reconnect" || event === "error") hungUp = true
            }
            if (finished || hungUp) break
          }
          if (finished) break
        } catch (caught) {
          if (controller.signal.aborted) return
          consecutiveFailures += 1
          if (consecutiveFailures > 5) throw caught
          // The run outlives its readers, so a dead connection is not a dead run.
          // Ask the snapshot route, which both advances the transcript and reveals
          // whether the thing we lost contact with has already finished.
          const recovered = await snapshot().catch(() => null)
          if (recovered) {
            adoptRun(recovered)
            if (recovered.done) break
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * consecutiveFailures, 5_000)))
        }
      }

      if (controller.signal.aborted) return
      // Re-widened deliberately: `run` is only ever assigned inside `adoptRun`, and
      // TypeScript's flow analysis does not look into that closure — so without this
      // it narrows to `null` here and the status checks below become unreachable.
      const finalRun = run as SerializedRun | null
      const text = (resultText ?? turn.text).trim()
      const succeeded = !finalRun || finalRun.status === "SUCCEEDED"
      if (text || succeeded) {
        // Keyed on the run id, so a reattach that lands after the server already
        // wrote its own assistant message is at worst a duplicate on screen until
        // the next server render — never a lost reply.
        setMessages((m) => [
          ...m,
          { id: `run-${runId}`, role: "assistant", content: text || "(no response)", toolCalls: settleSteps(turn.steps) },
        ])
      }
      if (reportedFailure) setError(reportedFailure)
      else if (finalRun && !succeeded) setError(runFailureText(finalRun.status, finalRun.error))
      setStreamingText("")
      setLiveToolSteps([])
      setPhase("idle")
      setActiveRun(null)
      // Deferred to here on purpose: `router.refresh()` re-renders the server
      // component that supplies `initialMessages`, and doing that mid-run would
      // re-seed the transcript out from under the stream the user is reading.
      if (!isRail) router.refresh()
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : "Lost contact with the agent run.")
      setStreamingText("")
      setLiveToolSteps([])
      setPhase("idle")
    } finally {
      // Dropped even on abort: an abandoned viewer must not stop the next one from
      // reattaching to the same run.
      watchedRuns.current.delete(runId)
      if (runController.current === controller) {
        runController.current = null
        sending.current = false
      }
    }
  }, [isRail, router])

  /**
   * Stop a run server-side. No local state change: the watcher sees the terminal
   * status and reports whatever actually happened, which may be a result that
   * landed while the request was in flight.
   */
  const cancelRun = useCallback(async (runId: string) => {
    try {
      await fetch(`/api/agent/runs/${runId}`, { method: "DELETE" })
    } catch {
      setError("Could not reach the server to stop this run.")
    }
  }, [])

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
    // The same controller covers the POST and, on the detached path, the viewer it
    // hands off to — so the two abort points (unmount, thread switch) stop both.
    runController.current = controller
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

    let turn: AgentTurnState = emptyAgentTurnState
    let assembled = ""
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
      // 202 Accepted = the turn is a detached run. The POST is already over; the
      // agent is not attached to it, and neither is this tab's survival. From here
      // on this component is only a viewer.
      if (res.status === 202) {
        const accepted = await res.json() as { runId: string; conversationId: string }
        const createdId = accepted.conversationId && accepted.conversationId !== activeConversationId ? accepted.conversationId : null
        if (createdId) {
          selfCreated.current.add(createdId)
          onConversationCreatedRef.current?.(createdId)
          // Rewrite `?c=` immediately so a reload — or a tab closed now and
          // reopened in an hour — lands on the conversation that owns this run and
          // reattaches to it. `router.refresh()` waits until the run is done; see
          // watchRun.
          if (!isRail) router.replace(`${basePath}/agent?c=${createdId}`)
        }
        await watchRun(accepted.runId, controller)
        return
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
            // Same reducer the detached viewer uses — the payload shape is
            // identical because both originate in scripts/agent/turn-entry.ts.
            const next = applyAgentSdkEvent(p, turn)
            if (next !== turn) {
              turn = next
              assembled = turn.text
              setStreamingText(turn.text)
              setLiveToolSteps(turn.steps)
            }
          } else if (event === "result") {
            if (typeof p.text === "string" && p.text) assembled = p.text
            if (typeof p.conversationId === "string") newConversationId = p.conversationId
          } else if (event === "error") {
            throw new Error(typeof p.message === "string" ? p.message : "The agent hit an error.")
          }
        }
      }

      setMessages((m) => [
        ...m,
        { id: `a-${Date.now()}`, role: "assistant", content: assembled || "(no response)", toolCalls: settleSteps(turn.steps) },
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
  }, [input, workspaceId, activeConversationId, basePath, router, isRail, processing?.canContinue, pendingSeedEntity, watchRun])

  // Reattach to a run already in flight for this conversation.
  //
  // This is the payoff for making runs durable: a reopened tab asks the
  // conversation what is running, then replays the event log from seq 0 to rebuild
  // the live view. It is also harmless in the tab that started the run — watchRun's
  // own guard means the second reader is never opened.
  useEffect(() => {
    if (!activeConversationId) return
    let cancelled = false
    const lookup = new AbortController()
    void (async () => {
      try {
        const res = await fetch(
          `/api/agent/conversations/${activeConversationId}/run?workspaceId=${encodeURIComponent(workspaceId)}`,
          { signal: lookup.signal },
        )
        if (cancelled || !res.ok) return
        const body = await res.json() as { run: SerializedRun | null; available: boolean }
        if (cancelled || !body.run || body.run.done) return
        if (watchedRuns.current.has(body.run.id)) return
        const controller = new AbortController()
        runController.current = controller
        // Block the composer for the duration: one conversation may have only one
        // run in flight, and the server would 409 a second turn anyway.
        sending.current = true
        setActiveRun(body.run)
        setPhase(body.run.status === "QUEUED" ? "booting" : "running")
        await watchRun(body.run.id, controller)
      } catch {
        // Best-effort: failing to reattach leaves a normal, idle chat on screen,
        // and the run carries on regardless.
      }
    })()
    return () => {
      cancelled = true
      lookup.abort()
    }
  }, [activeConversationId, workspaceId, watchRun])

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

            {/* Only shown for a detached run, because it is only true of one: the
                synchronous fallback still dies with this request. */}
            {activeRun && !activeRun.done && (
              <p className="pl-10 text-xs text-text-subtle">
                This runs on the server — you can close this tab and pick the reply up here later.
              </p>
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
            {activeRun && !activeRun.done ? (
              <Button
                size="icon"
                variant="outline"
                onClick={() => void cancelRun(activeRun.id)}
                aria-label="Stop this agent run"
                title="Stop this run"
              >
                <Square className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button size="icon" onClick={() => void send()} disabled={isStreaming || composerBlocked || !input.trim()} aria-label="Send message">
                <Send className="size-4" aria-hidden="true" />
              </Button>
            )}
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
