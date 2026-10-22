import { describe, expect, it } from "vitest"
import { providerSandboxEnv, resolveAgentModel, type ResolvedAgentModel } from "@/lib/agent-model"

function ok(env: Record<string, string | undefined>) {
  const r = resolveAgentModel(env)
  if (!r.ok) throw new Error(r.message)
  return r
}

describe("resolveAgentModel", () => {
  it("defaults to the Anthropic API", () => {
    const r = ok({ ANTHROPIC_API_KEY: "sk-ant" })
    expect(r).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-5", keyEnv: "ANTHROPIC_API_KEY" })
  })

  it("treats a blank AGENT_MODEL_PROVIDER as the default", () => {
    expect(ok({ AGENT_MODEL_PROVIDER: "  ", ANTHROPIC_API_KEY: "k" }).provider).toBe("anthropic")
  })

  it("selects Bedrock case-insensitively with its own default model", () => {
    const r = ok({ AGENT_MODEL_PROVIDER: " Bedrock ", BEDROCK_API_KEY: "b" })
    expect(r).toMatchObject({ provider: "bedrock", modelId: "global.anthropic.claude-sonnet-5-5", keyEnv: "BEDROCK_API_KEY" })
  })

  it("lets AGENT_MODEL_ID override either provider's default", () => {
    expect(ok({ AGENT_MODEL_ID: "claude-x", ANTHROPIC_API_KEY: "k" }).modelId).toBe("claude-x")
    expect(ok({ AGENT_MODEL_PROVIDER: "bedrock", AGENT_MODEL_ID: "eu.anthropic.y", BEDROCK_API_KEY: "k" }).modelId).toBe("eu.anthropic.y")
    expect(ok({ AGENT_MODEL_ID: " ", ANTHROPIC_API_KEY: "k" }).modelId).toBe("claude-sonnet-5")
  })

  it.each([undefined, "", "   \n"])("rejects a blank Anthropic key (%j)", value => {
    expect(resolveAgentModel({ ANTHROPIC_API_KEY: value })).toEqual({ ok: false, message: expect.stringContaining("ANTHROPIC_API_KEY") })
  })

  it.each([undefined, "", "   \n"])("rejects a blank Bedrock key (%j) even if an Anthropic key is set", value => {
    expect(resolveAgentModel({ AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: value, ANTHROPIC_API_KEY: "k" })).toEqual({
      ok: false,
      message: expect.stringContaining("BEDROCK_API_KEY"),
    })
  })

  it("rejects an unknown provider", () => {
    expect(resolveAgentModel({ AGENT_MODEL_PROVIDER: "vertex", ANTHROPIC_API_KEY: "k" })).toEqual({
      ok: false,
      message: expect.stringContaining("AGENT_MODEL_PROVIDER"),
    })
  })
})

describe("providerSandboxEnv", () => {
  const resolved = (env: Record<string, string>) => ok(env) as Extract<ResolvedAgentModel, { ok: true }>

  it("anthropic: only the API key and model", () => {
    expect(providerSandboxEnv(resolved({ ANTHROPIC_API_KEY: "k" }))).toEqual({ ANTHROPIC_API_KEY: "k", AGENT_MODEL: "claude-sonnet-5" })
  })

  it("bedrock: bearer token, provider switch, region (default and override), model", () => {
    const base = { AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: "b" }
    expect(providerSandboxEnv(resolved(base))).toEqual({
      AWS_BEARER_TOKEN_BEDROCK: "b",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AGENT_MODEL: "global.anthropic.claude-sonnet-5-5",
    })
    expect(providerSandboxEnv(resolved({ ...base, AWS_REGION: "eu-west-1" })).AWS_REGION).toBe("eu-west-1")
  })
})
