/**
 * Viewer-side serialization for durable agent runs.
 *
 * Shared by the snapshot route, the SSE tail, and the conversation payload, so
 * there is exactly one definition of what a run looks like to the browser. The
 * client's reattach logic keys off `lastSeq` and `done`; getting those two
 * subtly different in two places is how a tab ends up replaying a transcript it
 * already has, or waiting forever on a run that finished.
 */

import { isTerminalAgentRunStatus, type AgentRunStatus } from "@/lib/agent-runs"

export type SerializedAgentRun = {
  id: string
  conversationId: string
  workspaceId: string
  status: AgentRunStatus
  kind: string
  lastSeq: number
  eventCount: number
  done: boolean
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  numTurns: number | null
  costUsd: number | null
  durationMs: number | null
  error: string | null
  errorCode: string | null
  deadlineAt: string
  lastHeartbeatAt: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

type RunRow = {
  id: string
  conversationId: string
  workspaceId: string
  status: string
  kind: string
  lastSeq: number
  eventCount: number
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  numTurns?: number | null
  costUsd?: number | null
  durationMs?: number | null
  error?: string | null
  errorCode?: string | null
  deadlineAt: Date
  lastHeartbeatAt?: Date | null
  startedAt?: Date | null
  finishedAt?: Date | null
  createdAt: Date
}

export function serializeAgentRun(run: RunRow): SerializedAgentRun {
  return {
    id: run.id,
    conversationId: run.conversationId,
    workspaceId: run.workspaceId,
    status: run.status as AgentRunStatus,
    kind: run.kind,
    lastSeq: run.lastSeq,
    eventCount: run.eventCount,
    // Derived rather than left to the client: "is this over" is the one question
    // every consumer asks, and `status` is an open enum from their point of view.
    done: isTerminalAgentRunStatus(run.status),
    model: run.model ?? null,
    inputTokens: run.inputTokens ?? null,
    outputTokens: run.outputTokens ?? null,
    numTurns: run.numTurns ?? null,
    costUsd: run.costUsd ?? null,
    durationMs: run.durationMs ?? null,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    deadlineAt: run.deadlineAt.toISOString(),
    lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  }
}

export type SerializedAgentRunEvent = {
  seq: number
  type: string
  payload: unknown
  createdAt: string
}

/**
 * Stored payloads are TEXT (DSQL has no native JSON column here), and they were
 * written by a worker. A row that somehow holds unparseable text is surfaced as
 * `{ raw }` rather than throwing — one bad event must not make the rest of a
 * transcript unreadable.
 */
export function serializeAgentRunEvent(event: {
  seq: number
  type: string
  payloadJson: string
  createdAt: Date
}): SerializedAgentRunEvent {
  let payload: unknown
  try {
    payload = JSON.parse(event.payloadJson)
  } catch {
    payload = { raw: event.payloadJson }
  }
  return { seq: event.seq, type: event.type, payload, createdAt: event.createdAt.toISOString() }
}
