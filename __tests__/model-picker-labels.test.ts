import { describe, expect, it } from "vitest"
import { modelLabelFor, prettifyModelId } from "@/components/agent/model-picker"

describe("prettifyModelId", () => {
  it("names Bedrock inference-profile ids", () => {
    expect(prettifyModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Claude Sonnet 4.5")
    expect(prettifyModelId("anthropic.claude-opus-4-1-20250805-v1:0")).toBe("Claude Opus 4.1")
  })

  it("names bare Anthropic ids, with and without a minor version", () => {
    expect(prettifyModelId("claude-haiku-4-5")).toBe("Claude Haiku 4.5")
    expect(prettifyModelId("claude-opus-4")).toBe("Claude Opus 4")
  })

  it("leaves unrecognised ids unchanged", () => {
    expect(prettifyModelId("gpt-5")).toBe("gpt-5")
    expect(prettifyModelId("")).toBe("")
  })
})

describe("modelLabelFor", () => {
  const choices = {
    models: [{ value: "m1", label: "Custom One" }],
    modelLabels: { m2: "Server Two" },
  } as Parameters<typeof modelLabelFor>[0]

  it("prefers an option label, then the server label, then a prettified id", () => {
    expect(modelLabelFor(choices, "m1")).toBe("Custom One")
    expect(modelLabelFor(choices, "m2")).toBe("Server Two")
    expect(modelLabelFor(choices, "us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Claude Sonnet 4.5")
  })
})
