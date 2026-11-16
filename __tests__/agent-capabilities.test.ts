import { describe, it, expect } from "vitest"
import { describeCapabilities, formatList, OPENCODE_WEB_CAPABILITY_SENTENCE, WEB_CAPABILITY_SENTENCE, webCapabilitySentence } from "@/lib/agent-capabilities"

describe("describeCapabilities", () => {
  it("is the baseline sentence when nothing is connected", () => {
    // A user with no grants gets this exact text. "web" is not on the
    // unavailable list; the web sentence replaces it.
    expect(describeCapabilities([])).toBe(
      "Available host capability: compass.product_state. " +
        "Unavailable capabilities include local files, shell, GitHub, Jira, Vercel, Obsidian, hooks, commands, and subagents." +
        WEB_CAPABILITY_SENTENCE,
    )
  })

  it("does not tell the model the web is unavailable, since web_fetch is enabled", () => {
    // Regression: the prompt listed "web" as unavailable, so the model refused
    // "fetch https://example.com" without ever calling web_fetch.
    for (const connectors of [[], [{ slug: "v0", displayName: "v0" }]]) {
      const sentence = describeCapabilities(connectors)
      expect(sentence).not.toMatch(/Unavailable capabilities include[^.]*\bweb\b/)
      expect(sentence).toContain("web_fetch")
      expect(sentence).toContain("web_search")
    }
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
    expect(sentence).toContain("Unavailable capabilities include local files, shell, Jira,")
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

describe("describeCapabilities web search", () => {
  it("advertises web_search instead of saying search is impossible", () => {
    const sentence = describeCapabilities([])
    expect(sentence).toContain("web_search")
    expect(sentence).toContain("web_fetch")
    expect(sentence).not.toContain("cannot search the web")
    expect(sentence).toContain("untrusted")
    expect(sentence).not.toMatch(/Unavailable capabilities include[^.]*\bweb\b/)
  })
})

describe("web capability sentence per harness", () => {
  it("defaults to the Claude wording, which names web_fetch", () => {
    expect(webCapabilitySentence()).toBe(WEB_CAPABILITY_SENTENCE)
    expect(webCapabilitySentence("claude")).toContain("web_fetch")
    expect(describeCapabilities([], "claude")).toBe(describeCapabilities([]))
  })

  it("never names web_fetch or WebFetch for opencode, which has no such tool", () => {
    const text = describeCapabilities([], "opencode")
    expect(webCapabilitySentence("opencode")).toBe(OPENCODE_WEB_CAPABILITY_SENTENCE)
    expect(text).toContain("web_search")
    expect(text).not.toContain("web_fetch")
    expect(text).not.toContain("WebFetch")
    expect(text).toContain("cannot open or read arbitrary URLs")
  })

  it("changes only the web sentence between harnesses", () => {
    const strip = (text: string, sentence: string) => text.replace(sentence, "")
    expect(strip(describeCapabilities([{ slug: "v0", displayName: "v0" }], "opencode"), OPENCODE_WEB_CAPABILITY_SENTENCE)).toBe(
      strip(describeCapabilities([{ slug: "v0", displayName: "v0" }], "claude"), WEB_CAPABILITY_SENTENCE),
    )
  })
})
