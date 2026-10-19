import { describe, expect, it } from "vitest"
import { buildAskText, looksLikeQuestion, normalizeSelection, paletteMode, MAX_SELECTION_CHARS } from "@/lib/palette-ask-intent"

describe("looksLikeQuestion", () => {
  it.each([
    ["why is onboarding drop-off up?", true],
    ["onboarding?", true],
    ["Summarise this week", true],
    ["draft", true],
    ["Explain: churn", true],
    ["one two three four five", true],
    ["onboarding", false],
    ["pricing page", false],
    ["one two three four", false],
    ["showcase", false],
    ["  ", false],
  ])("%j -> %s", (query, expected) => {
    expect(looksLikeQuestion(query)).toBe(expected)
  })
})

describe("paletteMode", () => {
  it("is search for an empty query", () => {
    expect(paletteMode({ query: "" })).toBe("search")
  })
  it("is ask for an empty query with a selection", () => {
    expect(paletteMode({ query: "", hasSelection: true })).toBe("ask")
  })
  it("lets a typed lookup override the selection default", () => {
    expect(paletteMode({ query: "pricing", hasSelection: true })).toBe("search")
  })
  it("forceAsk wins", () => {
    expect(paletteMode({ query: "pricing", forceAsk: true })).toBe("ask")
  })
})

describe("normalizeSelection / buildAskText", () => {
  it("trims and caps the selection", () => {
    expect(normalizeSelection("  hi  ")).toBe("hi")
    expect(normalizeSelection("x".repeat(MAX_SELECTION_CHARS + 5))).toHaveLength(MAX_SELECTION_CHARS + 1)
  })
  it("returns the bare question without a selection", () => {
    expect(buildAskText(" why? ", "")).toBe("why?")
  })
  it("quotes the selection under the question", () => {
    expect(buildAskText("why?", "a\nb")).toBe("why?\n\n> a\n> b")
    expect(buildAskText("", "a")).toBe("About this selection:\n\n> a")
  })
})
