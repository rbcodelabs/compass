import { describe, expect, it } from "vitest"
import { buildAgentEnv } from "@/lib/agent-run-sandbox"
import { resolveAgentModel } from "@/lib/agent-model"

const base = { connectors: [], mcpBaseUrl: "https://compass.test", mcpToken: "t", prompt: "hi", workspaceId: "ws-1", systemPromptAppendices: [], pluginPaths: [], skillIds: [] }
function resolved(env: Record<string, string>) {
  const r = resolveAgentModel(env)
  if (!r.ok) throw new Error(r.message)
  return r
}

describe("buildAgentEnv model selection", () => {
  const anthropic = resolved({ ANTHROPIC_API_KEY: "k" })
  const bedrock = resolved({ AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: "b" })

  it("applies an explicit override on the Anthropic API, ahead of the agent's own model", () => {
    const env = buildAgentEnv({ ...base, harness: "claude", model: anthropic, agent: { name: "A", instructions: null, model: "claude-opus-9" }, modelOverride: "claude-haiku-9" })
    expect(env.AGENT_MODEL).toBe("claude-haiku-9")
  })

  it("does NOT apply the override on Bedrock: the deployment's profile id stays", () => {
    const env = buildAgentEnv({ ...base, harness: "claude", model: bedrock, agent: { name: "A", instructions: null, model: "claude-opus-9" }, modelOverride: "claude-haiku-9" })
    expect(env.AGENT_MODEL).toBe("global.anthropic.claude-sonnet-5-5")
    expect(JSON.stringify(env)).not.toContain("claude-haiku-9")
  })

  it("an override without an agent still applies on the Anthropic API, and is ignored when null", () => {
    expect(buildAgentEnv({ ...base, harness: "claude", model: anthropic, modelOverride: "claude-haiku-9" }).AGENT_MODEL).toBe("claude-haiku-9")
    expect(buildAgentEnv({ ...base, harness: "claude", model: anthropic, modelOverride: null }).AGENT_MODEL).toBe("claude-sonnet-5")
  })

  it("applies the override on the opencode harness", () => {
    expect(buildAgentEnv({ ...base, harness: "opencode", gatewayApiKey: "g", modelOverride: "openai/gpt-9" }).AGENT_MODEL).toBe("openai/gpt-9")
  })
})
