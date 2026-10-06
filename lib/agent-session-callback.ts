/**
 * Worker-authenticated upload of a finished Agent SDK transcript for a detached run.
 *
 * Same trust model as `lib/agent-run-callback.ts`: bearer worker token, authenticated
 * before the body is read, streaming size cap. The sandbox supplies bytes and a session
 * id; the conversation, workspace and Blob key all come from the run row, so a worker
 * can only ever write its own conversation's session.
 *
 * The worker must call this *before* it reports its terminal event: a terminal run no
 * longer has a bound token, which is also what stops a finished run from rewriting the
 * session later.
 */

import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { AgentRunError, authorizeAgentRunWorker } from "@/lib/agent-runs"
import {
  MAX_AGENT_SESSION_BYTES,
  agentSessionsAvailable,
  commitAgentSession,
  findRunUserMessageId,
  isSessionUuid,
} from "@/lib/agent-session"
import type { ArtifactStorage } from "@/lib/artifact-storage"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

async function readSessionBody(request: Request) {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim()
  if (type !== "application/gzip") throw new AgentRunError("application/gzip is required", 415, "INVALID_CONTENT_TYPE")
  if (Number(request.headers.get("content-length")) > MAX_AGENT_SESSION_BYTES) {
    throw new AgentRunError("Session is too large", 413, "SESSION_TOO_LARGE")
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
      if (total > MAX_AGENT_SESSION_BYTES) {
        await reader.cancel()
        throw new AgentRunError("Session is too large", 413, "SESSION_TOO_LARGE")
      }
      chunks.push(chunk.value)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    reader.releaseLock()
  }
}

export async function handleAgentSessionUpload(
  request: Request,
  runId: string,
  database?: AppPrismaClient,
  storage?: () => ArtifactStorage,
) {
  try {
    if (!uuid.test(runId) || new URL(request.url).search) return respond({ error: "Invalid callback URL" }, 400)
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
    if (!bearer) return respond({ error: "Worker bearer token required" }, 401)
    const prisma = database ?? getPrisma()

    const run = await authorizeAgentRunWorker({ prisma, runId, rawToken: bearer[1] })
    // Handoff runs own a claim and a different prompt contract; they never resume.
    if (run.kind !== "CHAT") return respond({ error: "This run does not keep a session", code: "SESSION_NOT_SUPPORTED" }, 409)

    const sessionId = request.headers.get("x-agent-session-id")
    if (!isSessionUuid(sessionId)) return respond({ error: "A session id is required", code: "INVALID_SESSION_ID" }, 400)
    if (!(await agentSessionsAvailable(prisma))) return respond({ error: "Sessions are unavailable", code: "SESSIONS_UNAVAILABLE" }, 503)

    const bytes = await readSessionBody(request)

    const created = await prisma.agentRun.findUnique({ where: { id: runId }, select: { createdAt: true } })
    const throughMessageId = created ? await findRunUserMessageId(prisma, run.conversationId, created.createdAt) : null
    if (!throughMessageId) return respond({ error: "No message to anchor the session", code: "INVALID_SESSION" }, 409)

    const result = await commitAgentSession({
      prisma,
      conversationId: run.conversationId,
      workspaceId: run.workspaceId,
      sessionId,
      throughMessageId,
      bytes,
      storage,
    })
    if (!result.committed) {
      return respond({ committed: false, code: result.reason }, result.reason === "INVALID" ? 422 : 200)
    }
    return respond({ committed: true, revision: result.revision })
  } catch (error) {
    if (error instanceof AgentRunError) return respond({ error: error.message, code: error.code }, error.status)
    console.error("Agent session upload failed", { runId })
    return respond({ error: "Agent session upload failed" }, 500)
  }
}
