/**
 * Worker-authenticated callbacks for durable agent runs.
 *
 * The sandbox reports in from outside any user request, so these routes are
 * authenticated by the run's worker bearer token rather than a session. They live
 * under /api/internal/ for exactly that reason: a session-authed namespace that
 * also accepts bearer tokens is one misread middleware away from a hole.
 *
 * Deliberately shaped like `lib/research-voice-callback.ts` — same bearer regex,
 * same authenticate-before-reading-the-body order, same streaming size cap, same
 * error→status mapping. Two callbacks instead of four, because an agent run has
 * no commands to claim.
 */

import { z } from "zod"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import {
  AGENT_RUN_EVENT_TYPES,
  AgentRunError,
  MAX_AGENT_RUN_CALLBACK_BYTES,
  MAX_AGENT_RUN_CALLBACK_EVENTS,
  appendAgentRunEvents,
  authorizeAgentRunWorker,
  finalizeAgentRun,
  recordAgentRunHeartbeat,
  type AgentRunCleanup,
} from "@/lib/agent-runs"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/**
 * Transport cap, above the 256 KiB *payload* cap the control plane enforces
 * post-parse: the wire body also carries seq/type framing and JSON escaping, so
 * capping both at the same number would reject batches the control plane would
 * have accepted.
 */
const MAX_CALLBACK_BODY_BYTES = MAX_AGENT_RUN_CALLBACK_BYTES + 64 * 1024

const eventSchema = z
  .object({
    seq: z.number().int().min(1),
    type: z.enum(AGENT_RUN_EVENT_TYPES),
    payload: z.unknown(),
  })
  .strict()
const eventsSchema = z
  .object({ events: z.array(eventSchema).min(1).max(MAX_AGENT_RUN_CALLBACK_EVENTS) })
  .strict()

/**
 * Usage as the worker reports it — snake_case inside `usage` because that is the
 * Agent SDK's own shape, forwarded rather than re-spelled. Loose on purpose: a new
 * SDK usage field must not 400 a run's only chance to record its result.
 */
const usageSchema = z.looseObject({
  durationMs: z.number().nullish(),
  numTurns: z.number().int().nullish(),
  totalCostUsd: z.number().nullish(),
  usage: z
    .looseObject({ input_tokens: z.number().int().nullish(), output_tokens: z.number().int().nullish() })
    .nullish(),
})
const resultPayloadSchema = z.looseObject({ text: z.string().max(200_000), usage: usageSchema.nullish() })
const errorPayloadSchema = z.looseObject({ message: z.string().max(4_000).optional() })

const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function readCallbackBody(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    throw new AgentRunError("JSON is required", 415, "INVALID_CONTENT_TYPE")
  }
  if (Number(request.headers.get("content-length")) > MAX_CALLBACK_BODY_BYTES) {
    throw new AgentRunError("Callback is too large", 413, "CALLBACK_PAYLOAD_TOO_LARGE")
  }
  if (!request.body) throw new AgentRunError("Body is required", 400, "INVALID_CALLBACK_BODY")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      // A lying (or absent) content-length must not be the only guard.
      if (total > MAX_CALLBACK_BODY_BYTES) {
        await reader.cancel()
        throw new AgentRunError("Callback is too large", 413, "CALLBACK_PAYLOAD_TOO_LARGE")
      }
      chunks.push(chunk.value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    } catch {
      throw new AgentRunError("Invalid JSON", 400, "INVALID_CALLBACK_BODY")
    }
  } finally {
    reader.releaseLock()
  }
}

type IncomingEvent = z.infer<typeof eventSchema>

/**
 * The terminal event in a batch, if any. Searched from the end so a worker that
 * somehow reported twice in one batch is finalized by its last word.
 */
function terminalEvent(events: IncomingEvent[]) {
  return [...events].reverse().find((event) => event.type === "result" || event.type === "error")
}

export async function handleAgentRunCallback(
  request: Request,
  runId: string,
  action: "events" | "heartbeat",
  database?: AppPrismaClient,
  cleanup?: AgentRunCleanup,
) {
  try {
    if (!uuid.test(runId) || new URL(request.url).search) return respond({ error: "Invalid callback URL" }, 400)
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
    if (!bearer) return respond({ error: "Worker bearer token required" }, 401)
    const prisma = database ?? getPrisma()
    const rawToken = bearer[1]

    if (action === "heartbeat") {
      // No body at all: there is nothing a heartbeat could say that the run row
      // does not already know, and requiring one only adds a way to fail.
      return respond(await recordAgentRunHeartbeat({ prisma, runId, rawToken }))
    }

    // Authenticate before reading a streamed body, so an unauthenticated caller
    // cannot make us buffer 320 KiB. The ingestion transaction fences again.
    await authorizeAgentRunWorker({ prisma, runId, rawToken })
    const batch = eventsSchema.parse(await readCallbackBody(request))

    const appended = await appendAgentRunEvents({ prisma, runId, rawToken, events: batch.events })

    const terminal = terminalEvent(batch.events)
    if (!terminal) {
      return respond({
        status: appended.status,
        lastSeq: appended.lastSeq,
        accepted: appended.acceptedSeqs,
        replayed: appended.replayedSeqs,
      })
    }

    // Finalize on *presence* of a terminal event, not on it being newly accepted:
    // an attempt that stored the event and then lost the response would otherwise
    // leave the run RUNNING until the sweeper collected it, even though its result
    // is already on disk. `finalizeAgentRun` is first-write-wins, so calling it on
    // a replay is free.
    const outcome =
      terminal.type === "result"
        ? (() => {
            const payload = resultPayloadSchema.parse(terminal.payload)
            return { status: "SUCCEEDED" as const, text: payload.text, usage: payload.usage ?? null }
          })()
        : {
            status: "FAILED" as const,
            error: errorPayloadSchema.parse(terminal.payload ?? {}).message ?? "The agent reported an error.",
            errorCode: "WORKER_REPORTED",
          }
    const finalized = await finalizeAgentRun({ prisma, runId, rawToken, ...outcome, cleanup })

    return respond({
      status: finalized.status,
      lastSeq: appended.lastSeq,
      accepted: appended.acceptedSeqs,
      replayed: appended.replayedSeqs,
      finalized: finalized.finalized,
    })
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: "Invalid callback body" }, 400)
    if (error instanceof AgentRunError) return respond({ error: error.message, code: error.code }, error.status)
    console.error("Agent run callback failed", { runId, action })
    return respond({ error: "Agent run callback failed" }, 500)
  }
}
