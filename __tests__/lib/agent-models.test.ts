import { describe, expect, it } from "vitest"
import { allowedAgentModels, parseAgentModel } from "@/lib/agent-models"
import { agentModelForHarness } from "@/lib/agent-harness"

describe("agent models", () => {
  it("treats blank and null as the system default", () => {
    expect(parseAgentModel(undefined, {})).toBeNull()
    expect(parseAgentModel(null, {})).toBeNull()
    expect(parseAgentModel("  ", {})).toBeNull()
  })

  it("accepts only members of the allowed set, trimmed", () => {
    expect(parseAgentModel(" claude-sonnet-5-5 ", {})).toBe("claude-sonnet-5-5")
    expect(() => parseAgentModel("claude-made-up", {})).toThrow(/available models/)
    expect(() => parseAgentModel(7, {})).toThrow(/available models/)
  })

  it("extends the set from the deployment, keeping only well-formed entries (no whitespace or shell metacharacters)", () => {
    const env = { COMPASS_CLOUD_AGENT_MODELS: "claude-opus-9, openai/gpt-9 ,bad model,x;rm -rf /,claude-sonnet-5-5" }
    const values = allowedAgentModels(env).map((o) => o.value)
    expect(values).toEqual(expect.arrayContaining(["claude-opus-9", "openai/gpt-9"]))
    expect(values).not.toContain("bad model")
    expect(values.some((v) => v.includes(";"))).toBe(false)
    expect(values.filter((v) => v === "claude-sonnet-5-5")).toHaveLength(1)
    expect(parseAgentModel("openai/gpt-9", env)).toBe("openai/gpt-9")
  })

  it("every built-in option is servable by at least one harness", () => {
    for (const { value } of allowedAgentModels({})) {
      expect(agentModelForHarness(value, "claude") ?? agentModelForHarness(value, "opencode")).toBe(value)
    }
  })
})
