/**
 * Session-authenticated endpoint for per-conversation supervision state (`GET`) and
 * human supervision actions (`POST`: approve/discard proposed reply, answer/dismiss decision).
 */

import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import {
  AgentSupervisionError,
  answerAgentDecision,
  approveProposedReply,
  discardProposedReply,
  dismissAgentDecision,
  getConversationSupervisionState,
} from "@/lib/agent-supervision-actions"

export const runtime = "nodejs"
export const maxDuration = 300

const uuid = z.string().uuid()

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve_proposed_reply"),
    workspaceId: z.string().uuid(),
    text: z.string().max(8_000).optional(),
  }),
  z.object({
    action: z.literal("discard_proposed_reply"),
    workspaceId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("answer_decision"),
    itemId: z.string().uuid(),
    answerText: z.string().min(1).max(4_000),
  }),
  z.object({
    action: z.literal("dismiss_decision"),
    itemId: z.string().uuid(),
  }),
])

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) {
    return Response.json({ error: "Workspace required.", code: "INVALID_WORKSPACE" }, { status: 400 })
  }

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) {
    return Response.json({ error: "Conversation not found.", code: "CONVERSATION_NOT_FOUND" }, { status: 404 })
  }

  try {
    const state = await getConversationSupervisionState(getPrisma(), {
      conversationId,
      workspaceId,
      userId: session.user.id,
    })
    return Response.json(state, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AgentSupervisionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const { conversationId } = await params
  if (!uuid.safeParse(conversationId).success) {
    return Response.json({ error: "Conversation not found.", code: "CONVERSATION_NOT_FOUND" }, { status: 404 })
  }

  const rawBody = await request.json().catch(() => null)
  const parsed = actionSchema.safeParse(rawBody)
  if (!parsed.success) {
    return Response.json({ error: "Invalid supervision action payload.", code: "INVALID_PAYLOAD" }, { status: 400 })
  }

  const prisma = getPrisma()
  const userId = session.user.id

  try {
    switch (parsed.data.action) {
      case "approve_proposed_reply": {
        const result = await approveProposedReply({
          prisma,
          workspaceId: parsed.data.workspaceId,
          conversationId,
          userId,
          overrideText: parsed.data.text,
        })
        return Response.json(result, { headers: { "cache-control": "no-store" } })
      }
      case "discard_proposed_reply": {
        const result = await discardProposedReply({
          prisma,
          workspaceId: parsed.data.workspaceId,
          conversationId,
          userId,
        })
        return Response.json(result, { headers: { "cache-control": "no-store" } })
      }
      case "answer_decision": {
        const result = await answerAgentDecision({
          prisma,
          itemId: parsed.data.itemId,
          userId,
          answerText: parsed.data.answerText,
        })
        return Response.json(result, { headers: { "cache-control": "no-store" } })
      }
      case "dismiss_decision": {
        const result = await dismissAgentDecision({
          prisma,
          itemId: parsed.data.itemId,
          userId,
        })
        return Response.json(result, { headers: { "cache-control": "no-store" } })
      }
    }
  } catch (error) {
    if (error instanceof AgentSupervisionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error("[agent-supervision] action failed", { conversationId, error })
    return Response.json({ error: "Could not complete supervision action." }, { status: 500 })
  }
}
