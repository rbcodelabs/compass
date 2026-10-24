import getPrisma from "@/lib/db"

/**
 * Display titles for TaskLinks of linkedType AGENT_CONVERSATION, keyed
 * `AGENT_CONVERSATION:<conversationId>` to match the maps the task readers already
 * build for other link types. Untitled conversations fall back to a generic label.
 */
export async function agentConversationLinkTitles(workspaceId: string, conversationIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (conversationIds.length === 0) return titles
  const rows = await getPrisma().agentConversation.findMany({
    where: { id: { in: conversationIds }, workspaceId },
    select: { id: true, title: true },
  })
  for (const row of rows) titles.set(`AGENT_CONVERSATION:${row.id}`, row.title?.trim() || "Agent conversation")
  return titles
}
