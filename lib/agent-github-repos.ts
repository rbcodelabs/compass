import { DEFAULT_AGENT_GITHUB_ACCESS, isAgentGithubAccess, type AgentGithubAccess } from "@/lib/agent-github-access-level"

type WorkspaceReader = {
  workspace: { findUnique(args: { where: { id: string }; select: { agentGithubRepos: true } }): PromiseLike<{ agentGithubRepos: string | null } | null> }
}

export type AgentGithubConfig = { repos: string[]; access: AgentGithubAccess }

/**
 * Stored shape lives in the existing text column (no migration): a legacy JSON array of
 * "owner/name" strings means write access; `{"repos":[...],"access":"read"|"write"}` is the
 * current shape. Anything malformed reads as "no repos".
 */
export function parseStoredConfig(stored: string | null | undefined): AgentGithubConfig {
  const empty: AgentGithubConfig = { repos: [], access: DEFAULT_AGENT_GITHUB_ACCESS }
  if (!stored) return empty
  try {
    const value: unknown = JSON.parse(stored)
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
    if (Array.isArray(value)) return { repos: strings(value), access: DEFAULT_AGENT_GITHUB_ACCESS }
    if (value && typeof value === "object") {
      const { repos, access } = value as { repos?: unknown; access?: unknown }
      return { repos: strings(repos), access: isAgentGithubAccess(access) ? access : DEFAULT_AGENT_GITHUB_ACCESS }
    }
    return empty
  } catch {
    return empty
  }
}

/** Encode for storage; null when there are no repos. Write access keeps the legacy array shape. */
export function serializeConfig(config: AgentGithubConfig): string | null {
  if (!config.repos.length) return null
  return config.access === "write" ? JSON.stringify(config.repos) : JSON.stringify({ repos: config.repos, access: config.access })
}

export function parseStoredRepos(stored: string | null | undefined): string[] {
  return parseStoredConfig(stored).repos
}

/**
 * A workspace's approved agent repos. Never throws: this runs on the hot path
 * of every agent turn, and before migration 105 is applied the column doesn't
 * exist — a turn must still run, just without GitHub access.
 */
export async function readWorkspaceAgentGithub(prisma: WorkspaceReader, workspaceId: string): Promise<AgentGithubConfig> {
  try {
    const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { agentGithubRepos: true } })
    return parseStoredConfig(row?.agentGithubRepos)
  } catch (error) {
    console.error("[agent-github] could not read workspace repos", error instanceof Error ? error.message : "unknown error")
    return { repos: [], access: DEFAULT_AGENT_GITHUB_ACCESS }
  }
}

/** Repo list only; kept for callers that don't care about the access level. */
export async function readWorkspaceAgentRepos(prisma: WorkspaceReader, workspaceId: string): Promise<string[]> {
  return (await readWorkspaceAgentGithub(prisma, workspaceId)).repos
}
