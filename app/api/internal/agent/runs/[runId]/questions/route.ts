/**
 * Worker-authenticated endpoint where a live sandbox `AskUserQuestion` tool call registers its
 * structured question prompt(s) and enters `AWAITING_QUESTION` substatus.
 */

import { z } from "zod"
import getPrisma from "@/lib/db"
import { AgentRunError } from "@/lib/agent-runs"
import { postAgentRunQuestions, postRunQuestionsBodySchema } from "@/lib/agent-inbox-questions"

export const runtime = "nodejs"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params
  if (!uuid.test(runId) || new URL(request.url).search) {
    return respond({ error: "Invalid callback URL" }, 400)
  }
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")
  if (!bearer) {
    return respond({ error: "Worker bearer token required" }, 401)
  }

  try {
    const rawBody = await request.json().catch(() => null)
    const parsed = postRunQuestionsBodySchema.parse(rawBody)
    const created = await postAgentRunQuestions({
      prisma: getPrisma(),
      runId,
      rawToken: bearer[1],
      nativeToolUseId: parsed.nativeToolUseId,
      questions: parsed.questions,
    })
    return respond(created)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: "Invalid question payload" }, 400)
    if (error instanceof AgentRunError) return respond({ error: error.message, code: error.code }, error.status)
    console.error("[agent-questions-callback] failed to record run questions", { runId, error })
    return respond({ error: "Failed to record run questions" }, 500)
  }
}
