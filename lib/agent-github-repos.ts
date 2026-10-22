type WorkspaceReader = {
  workspace: { findUnique(args: { where: { id: string }; select: { agentGithubRepos: true } }): PromiseLike<{ agentGithubRepos: string | null } | null> }
}

/** Decode the stored JSON array; anything malformed reads as "no repos". */
export function parseStoredRepos(stored: string | null | undefined): string[] {
  if (!stored) return []
  try {
    const value: unknown = JSON.parse(stored)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

/**
 * A workspace's approved agent repos. Never throws: this runs on the hot path
 * of every agent turn, and before migration 105 is applied the column doesn't
 * exist — a turn must still run, just without GitHub access.
 */
export async function readWorkspaceAgentRepos(prisma: WorkspaceReader, workspaceId: string): Promise<string[]> {
  try {
    const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { agentGithubRepos: true } })
    return parseStoredRepos(row?.agentGithubRepos)
  } catch (error) {
    console.error("[agent-github] could not read workspace repos", error instanceof Error ? error.message : "unknown error")
    return []
  }
}
