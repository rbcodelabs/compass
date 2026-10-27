/**
 * Which model credential an in-app agent run used (TASK-89 follow-up).
 *
 * A closed set of non-secret labels, never a key, token, last-four or any fragment of one. The value is recorded on the run row
 * (agent_runs.credential_source, migration 111) and shown to people who can see the run, so the owner can tell whether the
 * platform key, a workspace's own key, the Claude subscription token, Bedrock or the AI Gateway paid for it.
 *
 * Kept free of server imports so client components can use the label helper.
 */
export const AGENT_CREDENTIAL_SOURCES = ["platform-api-key", "workspace-api-key", "claude-subscription", "bedrock", "gateway"] as const
export type AgentCredentialSource = (typeof AGENT_CREDENTIAL_SOURCES)[number]

const LABELS: Record<AgentCredentialSource, string> = {
  "platform-api-key": "Platform API key",
  "workspace-api-key": "Workspace API key",
  "claude-subscription": "Claude subscription",
  bedrock: "Bedrock",
  gateway: "AI Gateway",
}

/** Narrows an untrusted stored value. Anything outside the closed set (including a stray secret) reads as unknown, never echoed. */
export function parseAgentCredentialSource(value: unknown): AgentCredentialSource | null {
  return typeof value === "string" && (AGENT_CREDENTIAL_SOURCES as readonly string[]).includes(value) ? (value as AgentCredentialSource) : null
}

export function agentCredentialSourceLabel(source: AgentCredentialSource): string {
  return LABELS[source]
}

/** The source for a Claude-harness provider. `workspaceKey` is true only when the key came from the workspace's BYOK setting. */
export function credentialSourceForProvider(provider: "anthropic" | "bedrock" | "claude-subscription", workspaceKey: boolean): AgentCredentialSource {
  if (workspaceKey) return "workspace-api-key"
  if (provider === "bedrock") return "bedrock"
  if (provider === "claude-subscription") return "claude-subscription"
  return "platform-api-key"
}
