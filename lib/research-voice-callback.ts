import { z } from "zod"
import type { PrismaClient } from "@prisma/client"
import getPrisma from "@/lib/db"
import { isResearchAuthoritativeVoiceEnabled } from "@/lib/research-feature"
import { appendCanonicalVoiceBatch, ResearchVoiceControlPlaneError } from "@/lib/research-voice-control-plane"
import { authorizeResearchVoiceWorker, claimResearchVoiceCommand, completeResearchVoiceCommand, recordResearchVoiceHeartbeat } from "@/lib/research-voice-operations"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const providerId = z.string().min(1).max(255)
const eventSchema = z.object({
  voiceCallId: z.string(), sessionId: z.string(), providerEventId: providerId, providerItemId: providerId,
  providerPreviousItemId: providerId.nullable(), providerOrdinal: z.number().int().min(0),
  providerResponseId: providerId.nullable(), providerStatus: z.enum(["COMPLETED", "FAILED", "CANCELLED", "INCOMPLETE"]),
  role: z.enum(["PARTICIPANT", "INTERVIEWER"]), content: z.string().max(60_000),
}).strict()
const eventsSchema = z.object({ version: z.literal(1), batchId: z.string().regex(/^[a-f0-9]{64}$/), events: z.array(eventSchema).min(1).max(10) }).strict()
const resultSchema = z.object({ commandId: z.string().regex(uuid), claimEpoch: z.number().int().min(1).max(3), outcome: z.enum(["APPLIED", "FAILED"]), errorCode: z.string().regex(/^[A-Z0-9_]{1,50}$/).optional() }).strict()
const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function readCallbackBody(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new ResearchVoiceControlPlaneError("JSON is required", 415, "INVALID_CONTENT_TYPE")
  if (Number(request.headers.get("content-length")) > 65536) throw new ResearchVoiceControlPlaneError("Callback is too large", 413, "CALLBACK_PAYLOAD_TOO_LARGE")
  if (!request.body) throw new ResearchVoiceControlPlaneError("Body is required", 400, "INVALID_CALLBACK_BODY")
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > 65536) {
        await reader.cancel()
        throw new ResearchVoiceControlPlaneError("Callback is too large", 413, "CALLBACK_PAYLOAD_TOO_LARGE")
      }
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }
    catch { throw new ResearchVoiceControlPlaneError("Invalid JSON", 400, "INVALID_CALLBACK_BODY") }
  } finally { reader.releaseLock() }
}

export async function handleResearchVoiceCallback(request: Request, callId: string, action: "heartbeat" | "events" | "claim" | "result", database?: PrismaClient) {
  try {
    if (!uuid.test(callId) || new URL(request.url).search) return respond({ error: "Invalid callback URL" }, 400)
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
    if (!bearer) return respond({ error: "Worker bearer token required" }, 401)
    if (!isResearchAuthoritativeVoiceEnabled()) return respond({ error: "Authoritative voice is unavailable" }, 404)
    const prisma = database ?? getPrisma(), rawToken = bearer[1]
    // Authenticate before reading potentially streamed input. Mutators fence again.
    const call = await authorizeResearchVoiceWorker({ prisma, callId, rawToken })
    const body = await readCallbackBody(request)
    if (action === "heartbeat") {
      z.object({ state: z.literal("RUNNING") }).strict().parse(body)
      return respond(await recordResearchVoiceHeartbeat({ prisma, callId, rawToken }))
    }
    if (action === "claim") {
      z.object({}).strict().parse(body)
      return respond({ command: await claimResearchVoiceCommand({ prisma, callId, rawToken }) })
    }
    if (action === "result") return respond(await completeResearchVoiceCommand({ prisma, callId, rawToken, ...resultSchema.parse(body) }))
    const batch = eventsSchema.parse(body)
    if (batch.events.some((event) => event.voiceCallId !== callId || event.sessionId !== call.sessionId)) return respond({ error: "Callback binding mismatch" }, 409)
    const result = await appendCanonicalVoiceBatch({ prisma, voiceCallId: callId, sessionId: call.sessionId, workerToken: rawToken, events: batch.events })
    if (result.transcriptIntegrity !== "PENDING" || result.nextExpectedOrdinal !== batch.events.at(-1)!.providerOrdinal + 1) {
      return respond({ error: "Voice batch was not fully accepted", code: result.abortReason ?? "CALLBACK_NOT_CONTIGUOUS" }, 409)
    }
    return respond({ batchId: batch.batchId, nextProviderOrdinal: result.nextExpectedOrdinal, transcriptIntegrity: result.transcriptIntegrity, abortReason: result.abortReason })
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: "Invalid callback body" }, 400)
    if (error instanceof ResearchVoiceControlPlaneError) return respond({ error: error.message, code: error.code }, error.status)
    return respond({ error: "Voice callback failed" }, 500)
  }
}
