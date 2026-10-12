/**
 * Client-side accumulation of an agent turn's events.
 *
 * The same Agent SDK message shape now arrives through two transports: the
 * synchronous SSE stream a pre-migration turn still uses, and the durable event
 * log a detached run writes. Interpreting it twice is how the two views of one
 * turn drift apart, so the interpretation lives here and both callers reduce
 * through it.
 *
 * Pure and immutable on purpose: reattaching to a run means replaying its events
 * from `afterSeq = 0`, and a reducer that mutates shared state cannot be replayed.
 */

import { humanizeToolName } from "@/lib/agent-tools"

export type ToolStep = { id: string; label: string; status: "running" | "done" }

export type AgentTurnState = {
  /** Assistant text assembled so far. */
  text: string
  /** Tool calls in the order they were issued, `done` once their result lands. */
  steps: ToolStep[]
}

export const emptyAgentTurnState: AgentTurnState = { text: "", steps: [] }

/**
 * Fold one `agent` event into the turn state.
 *
 * Unknown block types are ignored rather than rejected: the payload is whatever
 * the Agent SDK emitted, and a new block kind must not break the transcript of a
 * turn that is otherwise fine.
 */
export function applyAgentSdkEvent(payload: unknown, state: AgentTurnState): AgentTurnState {
  const envelope = payload as { message?: { message?: { content?: unknown } } } | null | undefined
  const content = envelope?.message?.message?.content
  if (!Array.isArray(content)) return state

  let text = state.text
  let steps = state.steps
  for (const raw of content as Record<string, unknown>[]) {
    if (raw?.type === "text" && typeof raw.text === "string") {
      text += raw.text
    } else if (raw?.type === "tool_use" && typeof raw.name === "string") {
      const id = String(raw.id ?? steps.length)
      // Replay-safe: the same tool_use arriving twice (a re-read of the event log)
      // must not produce two rows in the tool strip.
      if (!steps.some((step) => step.id === id)) {
        steps = [...steps, { id, label: humanizeToolName(raw.name), status: "running" }]
      }
    } else if (raw?.type === "tool_result") {
      const id = String(raw.tool_use_id ?? "")
      // Guarded so a result for a step this view does not hold — a truncated
      // replay, or a re-read of an already-settled step — returns the state
      // unchanged rather than a fresh array that only looks different.
      if (steps.some((step) => step.id === id && step.status !== "done")) {
        steps = steps.map((step) => (step.id === id ? { ...step, status: "done" } : step))
      }
    }
  }
  return text === state.text && steps === state.steps ? state : { text, steps }
}

/** Every step marked done — what a finished turn's transcript row should show. */
export function settleSteps(steps: ToolStep[]): ToolStep[] {
  return steps.map((step) => ({ ...step, status: "done" as const }))
}

export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELED"

export type SerializedRun = {
  id: string
  conversationId: string
  status: RunStatus
  lastSeq: number
  done: boolean
  error: string | null
  errorCode: string | null
  deadlineAt: string
}

/** The banner text for a run that ended without a result of its own. */
export function runFailureText(status: RunStatus, error: string | null): string {
  if (status === "CANCELED") return "Run canceled."
  if (status === "INTERRUPTED") {
    return error?.trim() || "The run stopped before it finished. Your transcript is saved."
  }
  return error?.trim() || "The agent hit an error."
}
