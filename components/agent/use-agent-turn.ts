"use client"

// The agent turn lifecycle, shared by every surface that talks to the agent
// (the chat in the rail and on the full page, and the Cmd+K palette's quick
// ask). It owns the POST to /api/agent/turn and both transports the server can
// answer with, and nothing about what a *transcript* is — callers decide what to
// do with a finished reply via `onSettled`.
//
// Two transports, because the server has two paths (see app/api/agent/turn):
//
//   * `202 { runId }` — the turn is a *detached run*. The agent is no longer
//     attached to the POST at all: this hook becomes a viewer that tails
//     /api/agent/runs/:runId/stream, can be closed and reopened, and reattaches
//     via /api/agent/conversations/:id/run. Closing the tab no longer abandons
//     the turn, which is the whole point of detached runs.
//   * `text/event-stream` — the pre-migration fallback, where the turn lives and
//     dies with this request exactly as it used to.
//
// Both reduce through lib/agent-run-stream.ts so the two views of one turn cannot
// drift apart.

import { useCallback, useEffect, useRef, useState } from "react"
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

export type StreamPhase = "idle" | "booting" | "running"

export type TurnAssistantMessage = { id: string; content: string; toolCalls: ToolStep[] }

export type TurnSettlement = {
  /** The reply to show, or null when the run produced nothing and did not succeed. */
  assistant: TurnAssistantMessage | null
  /** Whether the turn ran as a detached run (as opposed to the inline stream fallback). */
  detached: boolean
}

export type StartTurnParams = {
  message: string
  conversationId?: string | null
  seedContext?: { entityType: string; entityId: string }
  /** A cloud agent id, or "builtin". Omitted = the server's default (personal, then workspace, then built-in). */
  agentId?: string
  /** Which page the user is looking at, for surfaces that float over it. */
  pageUrl?: string
  retry?: boolean
  continueTurn?: boolean
}

type Options = {
  workspaceId: string
  /**
   * The server assigned a new conversation to this turn. Fires as soon as it is
   * known for a detached run, and just before `onSettled` for the inline stream.
   */
  onConversationCreated?: (conversationId: string, info: { detached: boolean }) => void
  /** A turn finished and its reply is ready. Not called for turns that errored or were abandoned. */
  onSettled?: (settlement: TurnSettlement) => void
}

/**
 * The turn route answers some refusals as JSON ({ error, code }: an agent cap reached, an agent the caller may not run) and
 * others as plain text. Show the sentence either way, never the raw JSON.
 */
export function readTurnErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" && parsed.error) return parsed.error
  } catch { /* plain text */ }
  return body
}

export function useAgentTurn({ workspaceId, onConversationCreated, onSettled }: Options) {
  const [phase, setPhase] = useState<StreamPhase>("idle")
  const [streamingText, setStreamingText] = useState("")
  const [liveToolSteps, setLiveToolSteps] = useState<ToolStep[]>([])
  const [error, setError] = useState<string | null>(null)
  /** The detached run this hook is currently viewing, if any. */
  const [activeRun, setActiveRun] = useState<SerializedRun | null>(null)
  const [transport, setTransport] = useState<"run" | "stream" | null>(null)

  const sending = useRef(false)
  const streamController = useRef<AbortController | null>(null)
  /**
   * Aborts the *viewer* of a detached run — never the run itself, which lives in
   * a sandbox and is stopped only by DELETE or by the sweeper.
   */
  const runController = useRef<AbortController | null>(null)
  /**
   * Runs with a live reader here. The surface that started a run is already
   * watching it, so the reattach path must not open a second reader that
   * replays the same events into the same transcript.
   */
  const watchedRuns = useRef(new Set<string>())
  /** Stop was pressed before the server told us the run id. */
  const cancelRequested = useRef(false)
  const runIdRef = useRef<string | null>(null)
  const transportRef = useRef<"run" | "stream" | null>(null)

  // Through refs so an inline arrow from the caller can't change the identity of
  // the functions below (the handoff auto-dispatch reads `send` through a ref
  // precisely because churn there is how you get a double dispatch).
  const onConversationCreatedRef = useRef(onConversationCreated)
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onConversationCreatedRef.current = onConversationCreated
    onSettledRef.current = onSettled
  }, [onConversationCreated, onSettled])

  // Unmount only. A genuine thread switch calls `reset()` instead, which is the
  // one place that can tell adoption of a new conversation from switching.
  useEffect(() => () => {
    streamController.current?.abort()
    runController.current?.abort()
    sending.current = false
  }, [])

  const clearLive = useCallback(() => {
    setStreamingText("")
    setLiveToolSteps([])
    setPhase("idle")
  }, [])

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
      // Keyed on the run id, so a reattach that lands after the server already
      // wrote its own assistant message is at worst a duplicate on screen until
      // the next server render — never a lost reply.
      const assistant: TurnAssistantMessage | null =
        text || succeeded
          ? { id: `run-${runId}`, content: text || "(no response)", toolCalls: settleSteps(turn.steps) }
          : null
      if (reportedFailure) setError(reportedFailure)
      else if (finalRun && !succeeded) setError(runFailureText(finalRun.status, finalRun.error))
      clearLive()
      setActiveRun(null)
      onSettledRef.current?.({ assistant, detached: true })
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : "Lost contact with the agent run.")
      clearLive()
    } finally {
      // Dropped even on abort: an abandoned viewer must not stop the next one from
      // reattaching to the same run.
      watchedRuns.current.delete(runId)
      if (runController.current === controller) {
        runController.current = null
        sending.current = false
      }
    }
  }, [clearLive])

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

  /**
   * Stop whatever turn is in flight. Once the server has named the run this is
   * `cancelRun`; before that (the POST is still booting) it is remembered and
   * applied the moment the run id arrives, so a quick Stop cannot orphan a run.
   */
  const stopInlineStream = useCallback(() => {
    // Inline stream: the turn lives and dies with the request.
    streamController.current?.abort()
    sending.current = false
    clearLive()
    setError("Stopped.")
  }, [clearLive])
  const cancel = useCallback(async () => {
    if (runIdRef.current) {
      await cancelRun(runIdRef.current)
      return
    }
    if (!sending.current) return
    if (transportRef.current === "stream") {
      stopInlineStream()
      return
    }
    // Transport not known yet: aborting now could orphan a run the server is
    // about to report, so remember it and apply it when the response arrives.
    cancelRequested.current = true
  }, [cancelRun, stopInlineStream])

  /**
   * Begin a turn. Resolves when the turn has settled (or failed). Returns false
   * without doing anything if one is already in flight.
   */
  const start = useCallback(async (params: StartTurnParams): Promise<boolean> => {
    const text = params.message.trim()
    if (!text || sending.current) return false
    sending.current = true
    cancelRequested.current = false
    runIdRef.current = null
    transportRef.current = null
    setTransport(null)
    const controller = new AbortController()
    streamController.current = controller
    // The same controller covers the POST and, on the detached path, the viewer it
    // hands off to — so the two abort points (unmount, thread switch) stop both.
    runController.current = controller
    setError(null)
    setPhase("booting")
    setStreamingText("")
    setLiveToolSteps([])

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
          conversationId: params.conversationId ?? undefined,
          ...(params.seedContext ? { seedContext: params.seedContext } : {}),
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.pageUrl ? { pageUrl: params.pageUrl } : {}),
          ...(params.retry ? { retry: true } : {}),
          ...(params.continueTurn ? { continue: true } : {}),
        }),
      })
      if (controller.signal.aborted) return true
      if (!res.ok || !res.body) {
        const serverMsg = readTurnErrorMessage(await res.text().catch(() => ""))
        throw new Error(
          res.status === 401
            ? "Your session expired — reload and sign in."
            : serverMsg || `Request failed (${res.status}).`
        )
      }
      // 202 Accepted = the turn is a detached run. The POST is already over; the
      // agent is not attached to it, and neither is this tab's survival. From here
      // on this hook is only a viewer.
      if (res.status === 202) {
        const accepted = await res.json() as { runId: string; conversationId: string }
        transportRef.current = "run"
        setTransport("run")
        runIdRef.current = accepted.runId
        const createdId = accepted.conversationId && accepted.conversationId !== (params.conversationId ?? null) ? accepted.conversationId : null
        if (createdId) onConversationCreatedRef.current?.(createdId, { detached: true })
        if (cancelRequested.current) void cancelRun(accepted.runId)
        await watchRun(accepted.runId, controller)
        return true
      }

      transportRef.current = "stream"
      setTransport("stream")
      if (cancelRequested.current) {
        stopInlineStream()
        return true
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (controller.signal.aborted) return true
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

      const assistant: TurnAssistantMessage = {
        id: `a-${Date.now()}`,
        content: assembled || "(no response)",
        toolCalls: settleSteps(turn.steps),
      }
      clearLive()
      const createdId = newConversationId && newConversationId !== (params.conversationId ?? null) ? newConversationId : null
      if (createdId) onConversationCreatedRef.current?.(createdId, { detached: false })
      onSettledRef.current?.({ assistant, detached: false })
    } catch (err) {
      if (controller.signal.aborted) return true
      setError(err instanceof Error ? err.message : "Something went wrong.")
      clearLive()
    } finally {
      if (streamController.current === controller) sending.current = false
    }
    return true
  }, [workspaceId, cancelRun, watchRun, clearLive, stopInlineStream])

  /**
   * Become a viewer of a run that is already in flight. The run may be one
   * started in another tab, or — in a shared conversation — one another
   * participant started.
   */
  const attachToRun = useCallback(async (run: SerializedRun) => {
    if (watchedRuns.current.has(run.id)) return
    const controller = new AbortController()
    runController.current = controller
    // Block new turns for the duration: one conversation may have only one run
    // in flight, and the server would 409 a second turn anyway.
    sending.current = true
    runIdRef.current = run.id
    transportRef.current = "run"
    setTransport("run")
    setActiveRun(run)
    setPhase(run.status === "QUEUED" ? "booting" : "running")
    await watchRun(run.id, controller)
  }, [watchRun])

  /** Hang up on any viewer without touching the run itself. */
  const abortViewers = useCallback(() => {
    streamController.current?.abort()
    runController.current?.abort()
  }, [])

  /** Forget everything about the current turn (a thread switch). The run itself carries on. */
  const reset = useCallback(() => {
    streamController.current?.abort()
    runController.current?.abort()
    runController.current = null
    sending.current = false
    runIdRef.current = null
    setActiveRun(null)
    setStreamingText("")
    setLiveToolSteps([])
    setError(null)
    setPhase("idle")
    setTransport(null)
  }, [])

  return {
    phase,
    isStreaming: phase !== "idle",
    streamingText,
    liveToolSteps,
    error,
    setError,
    activeRun,
    transport,
    /** True while a turn is being sent or watched; also read by shared-thread polling. */
    sending,
    start,
    cancel,
    cancelRun,
    attachToRun,
    abortViewers,
    reset,
  }
}
