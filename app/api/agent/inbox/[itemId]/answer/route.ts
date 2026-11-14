/**
 * Session-authenticated endpoint where a human answers a `PENDING` `AskUserQuestion` prompt
 * from either the Agent Board (`Awaiting` column) or `AgentChat`.
 */

import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AgentQuestionError, answerAgentQuestion } from "@/lib/agent-inbox-questions"

export const runtime = "nodejs"
export const maxDuration = 300

const uuid = z.string().uuid()
const bodySchema = z.object({
  answerText: z.string().min(1).max(4_000),
})

export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const { itemId } = await params
  if (!uuid.safeParse(itemId).success) {
    return Response.json({ error: "Question not found.", code: "QUESTION_NOT_FOUND" }, { status: 404 })
  }

  const rawBody = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return Response.json({ error: "A non-empty answerText is required.", code: "INVALID_ANSWER" }, { status: 400 })
  }

  try {
    const result = await answerAgentQuestion({
      prisma: getPrisma(),
      itemId,
      userId: session.user.id,
      answerText: parsed.data.answerText,
    })
    return Response.json(result, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentQuestionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error("[agent-inbox-answer] failed to answer question", { itemId, error })
    return Response.json({ error: "Could not submit answer." }, { status: 500 })
  }
}
