import { describe, expect, it } from "vitest"
import {
  deriveConversationSummary,
  deriveLatestRunActivity,
  extractLatestPrUrl,
  formatPrBadge,
} from "@/lib/agent-card-derive"

describe("deriveLatestRunActivity", () => {
  it("extracts humanized tool activity and latest subagent descriptions", () => {
    const activity = deriveLatestRunActivity([
      { type: "status", payloadJson: JSON.stringify({ phase: "booting" }) },
      {
        type: "agent",
        payloadJson: JSON.stringify({
          message: {
            message: {
              content: [
                { type: "tool_use", name: "mcp__compass__search_help", input: { query: "scoring models" } },
              ],
            },
          },
        }),
      },
    ])
    expect(activity).toContain("scoring models")

    const subagent = deriveLatestRunActivity([
      {
        type: "agent",
        payloadJson: JSON.stringify({
          message: {
            message: {
              content: [
                { type: "tool_use", name: "Agent", input: { description: "Audit DSQL migrations" } },
              ],
            },
          },
        }),
      },
    ])
    expect(subagent).toBe("Subagent: Audit DSQL migrations")
  })

  it("redacts tool input arguments on claimed handoff runs", () => {
    const activity = deriveLatestRunActivity(
      [
        {
          type: "agent",
          payloadJson: JSON.stringify({
            message: {
              message: {
                content: [
                  {
                    type: "tool_use",
                    name: "mcp__compass__update_opportunity",
                    input: { title: "Confidential customer quote" },
                  },
                ],
              },
            },
          }),
        },
      ],
      { redactArgs: true },
    )
    expect(activity).toBeTruthy()
    expect(activity).not.toContain("Confidential")
  })

  it("returns null when events contain only assistant prose or heartbeats", () => {
    expect(
      deriveLatestRunActivity([
        { type: "heartbeat", payloadJson: "{}" },
        {
          type: "agent",
          payloadJson: JSON.stringify({ message: { message: { content: [{ type: "text", text: "Hello" }] } } }),
        },
      ]),
    ).toBeNull()
  })
})

describe("deriveConversationSummary", () => {
  it("strips markdown headings, links, emphasis, and fenced code blocks into a clean single line", () => {
    const md = `## Summary of findings\n\nI opened [PR #570](https://github.com/rbcodelabs/compass/pull/570) with **zero** regressions.\n\n\`\`\`ts\nconst hidden = true;\n\`\`\`\n- Verified unit tests`
    expect(deriveConversationSummary(md)).toBe(
      "Summary of findings I opened PR #570 with zero regressions. Verified unit tests",
    )
  })

  it("returns null for empty or code-only content and clips long summaries cleanly", () => {
    expect(deriveConversationSummary("   ")).toBeNull()
    expect(deriveConversationSummary("```bash\nls -la\n```")).toBeNull()
    const clipped = deriveConversationSummary("word ".repeat(100), 40)
    expect(clipped!.length).toBeLessThanOrEqual(40)
    expect(clipped!.endsWith("…")).toBe(true)
  })
})

describe("extractLatestPrUrl and formatPrBadge", () => {
  it("picks the most recent GitHub pull request URL and formats a compact PR badge", () => {
    const text =
      "Superseded https://github.com/rbcodelabs/compass/pull/512 with https://github.com/rbcodelabs/compass/pull/570."
    const url = extractLatestPrUrl(text)
    expect(url).toBe("https://github.com/rbcodelabs/compass/pull/570")
    expect(formatPrBadge(url)).toEqual({
      number: "570",
      repo: "rbcodelabs/compass",
      label: "PR #570",
    })
    expect(extractLatestPrUrl("https://github.com/rbcodelabs/compass/issues/12")).toBeNull()
    expect(formatPrBadge(null)).toBeNull()
  })
})
