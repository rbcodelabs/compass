import { describe, expect, it } from "vitest"
import { markdownToPlainText } from "@/lib/markdown-plain-text"

describe("markdownToPlainText", () => {
  it("strips markup and keeps blocks separated", () => {
    expect(markdownToPlainText("## Steps to reproduce\n\n1. Open **Settings**\n2. Click `Save`\n\n> quoted"))
      .toBe("Steps to reproduce Open Settings Click Save quoted")
  })

  it("keeps link text and image alt, drops raw HTML tags", () => {
    expect(markdownToPlainText("See [the docs](https://x.dev) ![diagram](a.png) <script>alert(1)</script>"))
      .toBe("See the docs diagram alert(1)")
  })

  it("handles GFM tables and task lists", () => {
    expect(markdownToPlainText("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] todo")).toBe("a b 1 2 todo")
  })

  it("passes plain text through and returns empty for nothing", () => {
    expect(markdownToPlainText("Just words")).toBe("Just words")
    expect(markdownToPlainText(null)).toBe("")
    expect(markdownToPlainText("   ")).toBe("")
  })
})
