/**
 * Session-authenticated lookup of `PENDING` `AskUserQuestion` prompts on one conversation,
 * used by `AgentChat` to render the interactive `QuestionPromptCard` above the composer.
 */

import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AgentQuestionError, listConversationPendingQuestions } from "@/lib/agent-inbox-questions"

export const runtime = "nodejs"

const uuid = z.string().uuid()

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) {
    return new Response("Workspace required", { status: 400 })
  }

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) {
    return new Response("Not found", { status: 404 })
  }

  try {
    const questions = await listConversationPendingQuestions(getPrisma(), {
      conversationId,
      workspaceId,
      userId: session.user.id,
    })
    return Response.json({ questions }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentQuestionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
