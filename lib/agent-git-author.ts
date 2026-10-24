/**
 * The git identity an agent's commits are authored as (migration 111).
 *
 * Vercel attributes a commit to a GitHub account by author email, and on a private repo only deploys commits whose author is a
 * member of the Vercel team. The built-in "Compass Agent" bot is not, so an agent that opens PRs can be set to commit as a real
 * team member instead. Both fields must be set; otherwise the bot identity is used.
 *
 * The values end up inside a git config file the sandbox user must not be able to influence, so they are validated here (host) AND
 * again where the file is written (scripts/agent/github-access.ts): single line, no quotes, backslashes or control characters.
 */

import type { AppPrismaClient } from "@/lib/db"

export type GitAuthor = { name: string; email: string }

const EMAIL = /^[^\s@"'\\<>]+@[^\s@"'\\<>]+\.[^\s@"'\\<>]+$/

export function parseGitAuthor(name: unknown, email: unknown): GitAuthor | null {
  if (typeof name !== "string" || typeof email !== "string") return null
  const n = name.trim()
  const e = email.trim()
  // eslint-disable-next-line no-control-regex
  if (!n || n.length > 100 || /[\u0000-\u001f\u007f"'\\<>]/.test(n)) return null
  if (!e || e.length > 254 || !EMAIL.test(e)) return null
  return { name: n, email: e }
}

/** Throws a user-facing error for an invalid pair; (null, null) clears. Returns the values to store. */
export function gitAuthorInput(name: string | null | undefined, email: string | null | undefined): GitAuthor | null {
  const n = (name ?? "").trim()
  const e = (email ?? "").trim()
  if (!n && !e) return null
  if (!n || !e) throw new Error("Set both a git author name and email, or leave both empty")
  const parsed = parseGitAuthor(n, e)
  if (!parsed) throw new Error("Git author name or email is not valid (no quotes, backslashes or angle brackets; email must look like name@host.tld)")
  return parsed
}

/** Env handed to the sandbox for a run. Empty when the agent has no (valid) author configured. */
export function gitAuthorEnv(author: GitAuthor | null): Record<string, string> {
  return author ? { AGENT_GIT_AUTHOR_NAME: author.name, AGENT_GIT_AUTHOR_EMAIL: author.email } : {}
}

/** An agent's configured author. Missing column, missing agent, or an invalid pair all read as null (the bot identity). */
export async function readAgentGitAuthor(prisma: AppPrismaClient, agentId: string): Promise<GitAuthor | null> {
  try {
    const row = await prisma.agent.findUnique({ where: { id: agentId }, select: { gitAuthorName: true, gitAuthorEmail: true } })
    return parseGitAuthor(row?.gitAuthorName, row?.gitAuthorEmail)
  } catch (error) {
    console.error("[agent-git-author] could not read agent git author", error instanceof Error ? error.message : "unknown error")
    return null
  }
}

/** Configured authors for a set of agents, for the settings screen. Empty when migration 111 is not applied. */
export async function loadAgentGitAuthors(prisma: AppPrismaClient, agentIds: string[]): Promise<Map<string, GitAuthor>> {
  const out = new Map<string, GitAuthor>()
  if (!agentIds.length) return out
  try {
    const rows = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, gitAuthorName: true, gitAuthorEmail: true } })
    for (const row of rows) {
      const author = parseGitAuthor(row.gitAuthorName, row.gitAuthorEmail)
      if (author) out.set(row.id, author)
    }
  } catch (error) {
    console.error("[agent-git-author] could not load agent git authors", error instanceof Error ? error.message : "unknown error")
  }
  return out
}
