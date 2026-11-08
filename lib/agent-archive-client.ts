/** Browser-side calls for archiving agent conversations (the rail and the agent page share them). */

export type ArchivedConversation = { id: string; title: string | null }

export async function setConversationArchived(
  workspaceId: string,
  conversationId: string,
  archived: boolean,
): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/agent/conversations/${conversationId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived }),
      },
    )
    return response.ok
  } catch {
    return false
  }
}

export async function fetchArchivedConversations(workspaceId: string): Promise<ArchivedConversation[]> {
  try {
    const response = await fetch(`/api/agent/conversations?workspaceId=${encodeURIComponent(workspaceId)}&archived=1`)
    if (!response.ok) return []
    const data = (await response.json()) as { conversations?: ArchivedConversation[] }
    return data.conversations ?? []
  } catch {
    return []
  }
}
