/**
 * Agent harness selection (EXPERIMENTAL).
 *
 * The in-app agent defaults to the Claude Agent SDK (`scripts/agent/turn-entry.ts`).
 * `AGENT_HARNESS=opencode` switches a deployment to the opencode harness
 * (`scripts/agent/opencode-turn-entry.ts`) running a Vercel AI Gateway model. It is
 * default-off and unreviewed by the architecture process: the opencode ADR in Compass
 * Docs is still pending approval, so nothing here may be treated as a committed
 * direction.
 *
 * Both harnesses speak the same stdout/callback contract, so the route, run stream
 * and audit code are harness-agnostic; only what is written into the sandbox, which
 * credential is forwarded differ. Those differences are
 * collected here.
 *
 * SEAM — per-workspace selection: `resolveAgentHarness` takes the deployment value
 * only. A workspace-level setting would be passed alongside it (and could only select
 * opencode when the deployment flag allows it); that needs a Workspace column plus a
 * settings UI, so it is deliberately not built in this slice.
 */

export type AgentHarness = "claude" | "opencode"

export const DEFAULT_AGENT_HARNESS: AgentHarness = "claude"

/**
 * Exact version of both `opencode-ai` (CLI) and `@opencode-ai/sdk`. Baked into the golden
 * snapshot via SANDBOX_DEPENDENCIES in lib/agent-sandbox.ts (so changing it changes
 * computeDepsFingerprint() and needs a snapshot rebuild). Must equal OPENCODE_VERSION in
 * scripts/agent/opencode-adapter.ts (tested).
 */
export const OPENCODE_PINNED_VERSION = "1.19.3"

/** Gateway model used when AGENT_OPENCODE_MODEL is unset. */
export const DEFAULT_OPENCODE_MODEL = "anthropic/claude-sonnet-5.5"

/**
 * Anything other than the exact value "opencode" is Claude: a typo in a deployment
 * variable must not silently move production traffic onto the experimental harness.
 */
export function resolveAgentHarness(deploymentValue?: string | null): AgentHarness {
  return deploymentValue?.trim().toLowerCase() === "opencode" ? "opencode" : DEFAULT_AGENT_HARNESS
}

export function opencodeModel(envValue?: string | null): string {
  return envValue?.trim() || DEFAULT_OPENCODE_MODEL
}

/**
 * Credential for the opencode harness, forwarded only to the opencode sandbox env.
 * An explicit `AI_GATEWAY_API_KEY` wins (local dev, or a deliberately scoped key).
 * Otherwise the deployment's built-in Vercel connection is used: the project's OIDC
 * token, which the AI Gateway accepts as a bearer credential. It is short-lived, and
 * the opencode sandbox exposes only the Compass MCP tools (no shell, no network
 * tools), so the model cannot read it.
 */
export function gatewayApiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const key = env.AI_GATEWAY_API_KEY?.trim()
  return key ? key : undefined
}

export async function resolveGatewayCredential(
  env: Record<string, string | undefined>,
  getOidc: () => Promise<string> = async () => (await import("@vercel/functions/oidc")).getVercelOidcToken()
): Promise<string | undefined> {
  const key = gatewayApiKeyFromEnv(env)
  if (key) return key
  try {
    const token = (await getOidc())?.trim()
    return token ? token : undefined
  } catch {
    return undefined
  }
}
