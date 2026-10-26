import { describe, expect, it } from "vitest"
import { providerSandboxEnv, resolveAgentModel, resolveProviderName } from "@/lib/agent-model"
import { buildAgentEnv } from "@/lib/agent-run-sandbox"
import { agentEgressPolicy } from "@/lib/agent-github-access"

const TOKEN = "sk-ant-oat01-operator-token-xyz"
const base = { connectors: [], mcpBaseUrl: "https://compass.test", mcpToken: "t", prompt: "hi", workspaceId: "ws-1", systemPromptAppendices: [], pluginPaths: [], skillIds: [] }

describe("operator-only AGENT_MODEL_PROVIDER=claude-subscription", () => {
  it("injects CLAUDE_CODE_OAUTH_TOKEN (and no ANTHROPIC_API_KEY) through buildAgentEnv when explicitly selected", () => {
    const model = resolveAgentModel({ AGENT_MODEL_PROVIDER: "claude-subscription", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-api03-platform" })
    if (!model.ok) throw new Error(model.message)
    const env = buildAgentEnv({ ...base, harness: "claude", model })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK")
    expect(env.AGENT_MODEL).toBe("claude-sonnet-5")
    expect(JSON.stringify(env)).not.toContain("sk-ant-api03-platform")
  })

  it("is ignored unless explicitly selected: the default provider never reads or forwards the token", () => {
    const model = resolveAgentModel({ ANTHROPIC_API_KEY: "sk-ant-api03-platform", CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    if (!model.ok) throw new Error(model.message)
    const env = buildAgentEnv({ ...base, harness: "claude", model })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-platform")
    expect(JSON.stringify(env)).not.toContain(TOKEN)
  })

  it("is ignored under bedrock and for look-alike provider names", () => {
    const bedrock = resolveAgentModel({ AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: "b", CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    if (!bedrock.ok) throw new Error(bedrock.message)
    expect(JSON.stringify(providerSandboxEnv(bedrock))).not.toContain(TOKEN)
    for (const name of ["subscription", "claude_subscription", "oauth"]) {
      expect(resolveProviderName({ AGENT_MODEL_PROVIDER: name })).toBeNull()
      expect(resolveAgentModel({ AGENT_MODEL_PROVIDER: name, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }).ok).toBe(false)
    }
  })

  it("fails closed with a message naming the variable when the token is blank, without a platform-key fallback", () => {
    const result = resolveAgentModel({ AGENT_MODEL_PROVIDER: "claude-subscription", CLAUDE_CODE_OAUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "sk-ant-api03-platform" })
    expect(result).toEqual({ ok: false, message: "CLAUDE_CODE_OAUTH_TOKEN is not configured on this deployment." })
  })

  it("is not forwarded to the opencode harness", () => {
    const env = buildAgentEnv({ ...base, harness: "opencode", gatewayApiKey: "g" })
    expect(JSON.stringify(env)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("honors a named agent's model like the Anthropic API, and allows api.anthropic.com egress", () => {
    const model = resolveAgentModel({ AGENT_MODEL_PROVIDER: "claude-subscription", CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    if (!model.ok) throw new Error(model.message)
    expect(buildAgentEnv({ ...base, harness: "claude", model, modelOverride: "claude-haiku-9" }).AGENT_MODEL).toBe("claude-haiku-9")
    expect((agentEgressPolicy({ mcpBaseUrl: "https://compass.test", model }) as { allow: string[] }).allow).toContain("api.anthropic.com")
  })
})
