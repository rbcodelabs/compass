import { describe, it, expect } from "vitest"
import { describeCapabilities, formatList } from "@/lib/agent-capabilities"

describe("describeCapabilities", () => {
  it("is unchanged from the hardcoded sentence when nothing is connected", () => {
    // This is the exact string the prompt carried before connectors existed. A
    // user with no grants must get byte-identical instructions.
    expect(describeCapabilities([])).toBe(
      "Available host capability: compass.product_state. " +
        "Unavailable capabilities include local files, shell, web, GitHub, Jira, Vercel, Obsidian, hooks, commands, and subagents.",
    )
  })

  it("advertises a connected connector as available", () => {
    const sentence = describeCapabilities([{ slug: "v0", displayName: "v0" }])
    expect(sentence).toContain("Available host capabilities: compass.product_state, v0.")
    expect(sentence).toContain("The user has connected v0;")
  })

  it("stops claiming a capability is unavailable once a connector provides it", () => {
    // The failure this prevents: the model is told GitHub is unavailable, so it
    // declines work the freshly connected server can actually do.
    const sentence = describeCapabilities([{ slug: "github", displayName: "GitHub" }])
    expect(sentence).not.toContain("GitHub, Jira")
    expect(sentence).toContain("Unavailable capabilities include local files, shell, web, Jira,")
    expect(sentence).toContain("Available host capabilities: compass.product_state, github.")
  })

  it("matches on the slug as well as the display name", () => {
    // A catalog entry whose displayName is prettier than the base list's wording
    // must still clear the base entry — the two are compared case-insensitively.
    expect(describeCapabilities([{ slug: "jira", displayName: "Jira Cloud" }])).not.toContain("Jira,")
  })

  it("does not remove an unrelated base capability", () => {
    // v0 is a Vercel product, but connecting it grants no Vercel platform access,
    // so "Vercel" must stay on the unavailable list.
    expect(describeCapabilities([{ slug: "v0", displayName: "v0" }])).toContain("Vercel")
  })
})

describe("formatList", () => {
  it("renders 0, 1, 2 and 3 items", () => {
    expect(formatList([])).toBe("none")
    expect(formatList(["a"])).toBe("a")
    expect(formatList(["a", "b"])).toBe("a, and b")
    expect(formatList(["a", "b", "c"])).toBe("a, b, and c")
  })
})
