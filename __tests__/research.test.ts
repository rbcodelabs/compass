import { describe, expect, it } from "vitest"
import { buildResearchPrompt, createResearchToken, hashResearchToken, parseResearchGuide } from "@/lib/research"

describe("research capture helpers", () => {
  it("creates an opaque token and stores only its SHA-256 hash", () => {
    const first = createResearchToken()
    const second = createResearchToken()
    expect(first.token).not.toBe(first.tokenHash)
    expect(first.tokenHash).toBe(hashResearchToken(first.token))
    expect(first.tokenHash).toHaveLength(64)
    expect(first.token).not.toBe(second.token)
  })

  it("turns a line-delimited guide into stable ordered items", () => {
    expect(parseResearchGuide("First question\n\n Second question ")).toEqual([
      { id: "1", text: "First question" },
      { id: "2", text: "Second question" },
    ])
  })

  it("preserves the order of individually submitted guide questions", () => {
    expect(parseResearchGuide([" First question ", "Second question"])).toEqual([
      { id: "1", text: "First question" },
      { id: "2", text: "Second question" },
    ])
  })

  it("builds a neutral one-question-at-a-time interview prompt", () => {
    const prompt = buildResearchPrompt([{ id: "1", text: "Tell me about the last time." }], 15)
    expect(prompt).toContain("Tell me about the last time.")
    expect(prompt).toContain("Ask one question at a time")
    expect(prompt).not.toContain("Helio")
  })
})
