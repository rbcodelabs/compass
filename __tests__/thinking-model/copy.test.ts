import { describe, expect, it } from "vitest"
import { linkPlaceholder, linkToPlaceholder, linkedToLabel } from "@/lib/thinking-model/copy"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

// These are the real functions the components call, pinned against the literals
// that shipped before the conversion (taken from origin/main's components).
describe("article-bearing copy under CLASSIC equals today's literals", () => {
  const l = resolveThinkingModel({ thinkingModel: null }).labels

  it.each([
    ["roadmap add-item / edit dialog opportunity", linkToPlaceholder(l.opportunity), "Link to an opportunity…"],
    ["roadmap add-item / overview key result", linkToPlaceholder(l.keyResult), "Link to a key result…"],
    ["roadmap add-item solution", linkToPlaceholder(l.solution), "Link to a solution…"],
    ["opportunity composer key result", linkPlaceholder(l.keyResult), "Link a key result"],
    ["discovery rail indicator", linkedToLabel(l.keyResult), "Linked to a key result"],
  ])("%s", (_name, built, literal) => {
    expect(built).toBe(literal)
  })

  it("Torres uses its own article; an override drops the article", () => {
    const torres = resolveThinkingModel({ thinkingModel: "TORRES_OST" }).labels
    expect(linkToPlaceholder(torres.keyResult)).toBe("Link to a success metric…")
    expect(linkToPlaceholder(torres.objective)).toBe("Link to an outcome…")
    const custom = resolveThinkingModel({ thinkingModelLabels: JSON.stringify({ objective: { singular: "Idea" } }) }).labels
    expect(linkToPlaceholder(custom.objective)).toBe("Link to idea…")
  })
})
