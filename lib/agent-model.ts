/**
 * Model provider selection for the in-app agent.
 *
 * Two providers are supported. Anthropic's own API is the default and is what
 * every deployment gets unless it opts in to something else:
 *
 *   AGENT_MODEL_PROVIDER   "anthropic" (default) | "bedrock" | "claude-subscription" (operator-only, see below)
 *   AGENT_MODEL_ID         overrides the provider's default model id
 *
 *   anthropic  key: ANTHROPIC_API_KEY             default model: claude-sonnet-5
 *   bedrock    key: BEDROCK_API_KEY (bearer token) default model:
 *              global.anthropic.claude-sonnet-5-5 (a Bedrock cross-region
 *              inference profile id, not an Anthropic API model name);
 *              region: AWS_REGION, default us-east-1
 *
 *   claude-subscription  key: CLAUDE_CODE_OAUTH_TOKEN  default model: claude-sonnet-5
 *              OPERATOR-ONLY, for a self-hosted deployment that serves only its operator. Env var only: there is no settings UI and
 *              nothing is stored in the database, so it can never be accepted from, or held for, another user. Anthropic's terms
 *              restrict subscription tokens to personal use of Claude Code; enabling this on a deployment that serves other
 *              users is a terms violation. It is used only when AGENT_MODEL_PROVIDER names it exactly; a CLAUDE_CODE_OAUTH_TOKEN
 *              left in the environment under any other setting is never read or forwarded. A workspace's own API key (BYOK,
 *              lib/workspace-anthropic-key.ts) still takes precedence over it.
 *
 * The turn route resolves the provider once and forwards the result into the
 * sandbox as env vars. scripts/agent/turn-entry.ts runs standalone inside the
 * sandbox (`node entry.ts`) and cannot import this module, so the env contract
 * built by {@link providerSandboxEnv} is how the choice reaches it.
 */
export type AgentModelProvider = "anthropic" | "bedrock" | "claude-subscription"

export const DEFAULT_AGENT_MODEL_PROVIDER: AgentModelProvider = "anthropic"

export const DEFAULT_MODEL_IDS: Record<AgentModelProvider, string> = {
  anthropic: "claude-sonnet-5",
  bedrock: "global.anthropic.claude-sonnet-5-5",
  "claude-subscription": "claude-sonnet-5",
}

/** Host env var holding the credential each provider needs. */
export const PROVIDER_KEY_ENV: Record<AgentModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  bedrock: "BEDROCK_API_KEY",
  "claude-subscription": "CLAUDE_CODE_OAUTH_TOKEN",
}

export const DEFAULT_BEDROCK_REGION = "us-east-1"

type Env = Record<string, string | undefined>

export type ResolvedAgentModel =
  | { ok: true; provider: AgentModelProvider; modelId: string; keyEnv: string; apiKey: string; env: Env }
  | { ok: false; message: string }

/** Unset or blank selects the default; anything else must be a known provider. */
export function resolveProviderName(env: Env = process.env): AgentModelProvider | null {
  const raw = env.AGENT_MODEL_PROVIDER?.trim().toLowerCase()
  if (!raw) return DEFAULT_AGENT_MODEL_PROVIDER
  return raw === "anthropic" || raw === "bedrock" || raw === "claude-subscription" ? raw : null
}

export function resolveModelId(provider: AgentModelProvider, env: Env = process.env): string {
  return env.AGENT_MODEL_ID?.trim() || DEFAULT_MODEL_IDS[provider]
}

/**
 * Resolve provider, model and credential, failing closed with a message naming
 * the exact variable to fix. `.trim()` on the key is load-bearing: a var added
 * with no value (or later cleared) is stored as "" rather than unset, and a
 * whitespace-only value would otherwise be forwarded into the sandbox as a
 * credential and only fail after a sandbox boot, as an opaque auth error.
 */
export function resolveAgentModel(env: Env = process.env): ResolvedAgentModel {
  const provider = resolveProviderName(env)
  if (!provider) {
    return { ok: false, message: `AGENT_MODEL_PROVIDER must be "anthropic", "bedrock" or "claude-subscription" (got "${env.AGENT_MODEL_PROVIDER}").` }
  }
  const keyEnv = PROVIDER_KEY_ENV[provider]
  const apiKey = env[keyEnv]
  if (!apiKey?.trim()) {
    return { ok: false, message: `${keyEnv} is not configured on this deployment.` }
  }
  return { ok: true, provider, modelId: resolveModelId(provider, env), keyEnv, apiKey, env }
}

/**
 * Env passed to the sandbox for the chosen provider. Only that provider's
 * credential is included, so the other provider's key never enters the sandbox.
 * AGENT_MODEL is always set; the entry script uses it as the Agent SDK model.
 */
export function providerSandboxEnv(model: Extract<ResolvedAgentModel, { ok: true }>): Record<string, string> {
  if (model.provider === "bedrock") {
    return {
      // Agent SDK Bedrock routing: a long-lived bearer token (not SigV4
      // access-key/secret), the provider switch, and the region.
      AWS_BEARER_TOKEN_BEDROCK: model.apiKey,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: model.env.AWS_REGION?.trim() || DEFAULT_BEDROCK_REGION,
      AGENT_MODEL: model.modelId,
    }
  }
  if (model.provider === "claude-subscription") {
    // The Claude Code CLI reads this variable itself. ANTHROPIC_API_KEY is deliberately absent: it would take precedence over the token.
    return { CLAUDE_CODE_OAUTH_TOKEN: model.apiKey, AGENT_MODEL: model.modelId }
  }
  return { ANTHROPIC_API_KEY: model.apiKey, AGENT_MODEL: model.modelId }
}
