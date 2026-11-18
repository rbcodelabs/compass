/**
 * Per-workspace choice an admin makes for agent GitHub access: "write" lets agents push
 * branches and open PRs, "read" lets them clone and inspect (including PRs and issues)
 * but never push, and "code-read" is the same without pull request access (for Apps not
 * yet granted pull_requests). Kept dependency-free so storage and UI code can import it without
 * pulling in the Vercel Connect client.
 */
export type AgentGithubAccess = "code-read" | "read" | "write"
export const DEFAULT_AGENT_GITHUB_ACCESS: AgentGithubAccess = "write"

export function isAgentGithubAccess(value: unknown): value is AgentGithubAccess {
  return value === "code-read" || value === "read" || value === "write"
}
