import { describe, expect, it } from "vitest"
import { thinkingModelForMcp } from "@/lib/thinking-model/mcp"

describe("thinkingModelForMcp", () => {
  it("CLASSIC: structured data, no vocabulary line", () => {
    const r = thinkingModelForMcp({ thinkingModel: null, thinkingModelLabels: null })
    expect(r.structured.key).toBe("CLASSIC")
    expect(r.structured.name).toBe("Classic OKRs")
    expect(r.structured.labels.objective).toEqual({ singular: "Objective", plural: "Objectives" })
    expect(r.line).toBeNull()
  })

  it("Torres: names the renamed entities and says API names are unchanged", () => {
    const r = thinkingModelForMcp({ thinkingModel: "TORRES_OST", thinkingModelLabels: null })
    expect(r.structured.key).toBe("TORRES_OST")
    expect(r.structured.labels.objective).toEqual({ singular: "Outcome", plural: "Outcomes" })
    expect(r.line).toBe(
      'This workspace calls Objectives "Outcomes" and Key Results "Success metrics"; API and tool names are unchanged.',
    )
  })

  it("includes overrides", () => {
    const r = thinkingModelForMcp({
      thinkingModel: "CLASSIC",
      thinkingModelLabels: JSON.stringify({ solution: { singular: "Bet" } }),
    })
    expect(r.line).toBe('This workspace calls Solutions "Bets"; API and tool names are unchanged.')
  })

  it("corrupt stored labels fall back safely", () => {
    const r = thinkingModelForMcp({ thinkingModel: "CLASSIC", thinkingModelLabels: "{oops" })
    expect(r.line).toBeNull()
  })
})
