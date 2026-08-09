/**
 * Read access for the agent chat UI (Phase 4). Session + workspace-membership
 * scoping is enforced by the workspace layout (lib/workspace.ts) and the page;
 * these helpers additionally scope every query by (workspaceId, userId) so a
 * user only ever reads their own conversations in a workspace they belong to.
 */

import getPrisma from "@/lib/db"

export type ConversationSummary = {
  id: string
  title: string | null
  updatedAt: Date
}

export type ChatMessage = {
  id: string
  role: string
  content: string
  createdAt: Date
}

/** A user's conversations in a workspace, most-recently-updated first. */
export async function listAgentConversations(
  workspaceId: string,
  userId: string
): Promise<ConversationSummary[]> {
  const prisma = getPrisma()
  return prisma.agentConversation.findMany({
    where: { workspaceId, userId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
    take: 50,
  })
}

/**
 * Messages for one conversation, oldest-first. Returns null if the conversation
 * doesn't exist or isn't owned by this user in this workspace (no data leak).
 */
export async function getAgentConversationMessages(
  conversationId: string,
  workspaceId: string,
  userId: string
): Promise<ChatMessage[] | null> {
  const prisma = getPrisma()
  const convo = await prisma.agentConversation.findFirst({
    where: { id: conversationId, workspaceId, userId },
    select: { id: true },
  })
  if (!convo) return null
  return prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, createdAt: true },
  })
}
