/**
 * Which model credential an in-app agent run used (TASK-89 follow-up).
 *
 * A closed set of non-secret labels, never a key, token, length, prefix, last-four or any fragment of one. The label is written to the
 * server log once per run (see {@link logAgentRunCredentialSource}); it is not stored in the database or shown in the UI.
 */
export const AGENT_CREDENTIAL_SOURCES = ["platform-api-key", "workspace-api-key", "claude-subscription", "bedrock", "gateway"] as const
export type AgentCredentialSource = (typeof AGENT_CREDENTIAL_SOURCES)[number]

/** Narrows an untrusted stored value. Anything outside the closed set (including a stray secret) reads as unknown, never echoed. */
export function parseAgentCredentialSource(value: unknown): AgentCredentialSource | null {
  return typeof value === "string" && (AGENT_CREDENTIAL_SOURCES as readonly string[]).includes(value) ? (value as AgentCredentialSource) : null
}

/** The source for a Claude-harness provider. `workspaceKey` is true only when the key came from the workspace's BYOK setting. */
export function credentialSourceForProvider(provider: "anthropic" | "bedrock" | "claude-subscription", workspaceKey: boolean): AgentCredentialSource {
  if (workspaceKey) return "workspace-api-key"
  if (provider === "bedrock") return "bedrock"
  if (provider === "claude-subscription") return "claude-subscription"
  return "platform-api-key"
}

/**
 * The source for a run, or null when it has none (a failed resolution). The opencode harness uses only the AI Gateway credential;
 * the Claude harness uses whatever the resolved model carries.
 */
export function agentRunCredentialSource(input: {
  harness: "claude" | "opencode"
  model: { provider: "anthropic" | "bedrock" | "claude-subscription"; credentialSource?: AgentCredentialSource } | undefined
}): AgentCredentialSource | null {
  if (input.harness === "opencode") return "gateway"
  if (!input.model) return null
  return input.model.credentialSource ?? credentialSourceForProvider(input.model.provider, false)
}

/** The one log line per run. Only the run id, workspace id and a closed label; ids are validated shapes upstream, the label is re-checked here. */
export function formatAgentRunCredentialSourceLine(input: { runId: string; workspaceId: string; source: AgentCredentialSource }): string | null {
  const source = parseAgentCredentialSource(input.source)
  return source ? `agent-run credential source=${source} runId=${input.runId} workspaceId=${input.workspaceId}` : null
}

/** Emit the line (search "agent-run credential source" in Vercel runtime logs). Call exactly once per run, where the run is created. */
export function logAgentRunCredentialSource(input: { runId: string; workspaceId: string; source: AgentCredentialSource | null }): void {
  if (!input.source) return
  const line = formatAgentRunCredentialSourceLine({ runId: input.runId, workspaceId: input.workspaceId, source: input.source })
  if (line) console.info(line)
}
