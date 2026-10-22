import { describe, expect, it } from "vitest"
import { agentOwnModel, deploymentDefaultModel, effectiveTurnModel, modelChoiceSupported, parseRequestedTurnModel, selectableTurnModels } from "@/lib/agent-turn-model"

const EXTRA = { COMPASS_CLOUD_AGENT_MODELS: "claude-opus-9,openai/gpt-9" }

describe("selectableTurnModels", () => {
  it("offers only the allowed models the harness can serve", () => {
    expect(selectableTurnModels("claude", EXTRA).map((m) => m.value)).toEqual(["claude-sonnet-5", "claude-opus-9"])
    expect(selectableTurnModels("opencode", EXTRA).map((m) => m.value)).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-9"])
  })
  it("offers nothing on Bedrock or an unusable provider, where Anthropic-API names are invalid", () => {
    expect(selectableTurnModels("claude", { ...EXTRA, AGENT_MODEL_PROVIDER: "bedrock" })).toEqual([])
    expect(selectableTurnModels("claude", { AGENT_MODEL_PROVIDER: "vertex" })).toEqual([])
    expect(modelChoiceSupported("opencode", { AGENT_MODEL_PROVIDER: "bedrock" })).toBe(true)
  })
})

describe("parseRequestedTurnModel", () => {
  it("treats absent, null and blank as no pick", () => {
    for (const v of [undefined, null, "", "   "]) expect(parseRequestedTurnModel(v, "claude", {})).toEqual({ ok: true, model: null })
  })
  it("accepts an offered id, trimmed", () => {
    expect(parseRequestedTurnModel(" claude-opus-9 ", "claude", EXTRA)).toEqual({ ok: true, model: "claude-opus-9" })
  })
  it("refuses unknown, unservable and non-string values with INVALID_MODEL", () => {
    for (const v of ["claude-made-up", "openai/gpt-9", "claude-sonnet-5; rm -rf /", 7, {}, ["claude-sonnet-5"]]) {
      expect(parseRequestedTurnModel(v, "claude", EXTRA)).toMatchObject({ ok: false, code: "INVALID_MODEL" })
    }
  })
  it("refuses any pick on Bedrock with a distinct code", () => {
    expect(parseRequestedTurnModel("claude-sonnet-5", "claude", { AGENT_MODEL_PROVIDER: "bedrock" })).toMatchObject({ ok: false, code: "MODEL_CHOICE_UNAVAILABLE" })
  })
})

describe("effectiveTurnModel precedence", () => {
  it("explicit > agent > deployment default", () => {
    expect(effectiveTurnModel({ explicit: "claude-opus-9", agentModel: "claude-haiku-9", harness: "claude", env: {} })).toBe("claude-opus-9")
    expect(effectiveTurnModel({ explicit: null, agentModel: "claude-haiku-9", harness: "claude", env: {} })).toBe("claude-haiku-9")
    expect(effectiveTurnModel({ explicit: null, agentModel: null, harness: "claude", env: {} })).toBe("claude-sonnet-5")
    expect(effectiveTurnModel({ explicit: null, agentModel: null, harness: "claude", env: { AGENT_MODEL_ID: "claude-opus-9" } })).toBe("claude-opus-9")
  })
  it("ignores an agent model the harness cannot serve", () => {
    expect(effectiveTurnModel({ explicit: null, agentModel: "openai/gpt-9", harness: "claude", env: {} })).toBe("claude-sonnet-5")
    expect(effectiveTurnModel({ explicit: null, agentModel: "claude-opus-9", harness: "opencode", env: {} })).toBe("anthropic/claude-sonnet-5.5")
  })
  it("on Bedrock the agent's model is ignored and the profile id is the answer", () => {
    const env = { AGENT_MODEL_PROVIDER: "bedrock" }
    expect(agentOwnModel("claude-opus-9", "claude", env)).toBeNull()
    expect(effectiveTurnModel({ explicit: null, agentModel: "claude-opus-9", harness: "claude", env })).toBe("global.anthropic.claude-sonnet-5-5")
    expect(deploymentDefaultModel("claude", env)).toBe("global.anthropic.claude-sonnet-5-5")
  })
})
