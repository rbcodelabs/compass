import { describe, expect, it } from "vitest"

import { parsePullRequestPanelId, parsePullRequestUrl, pullRequestPanelId } from "@/lib/github-pull-request-links"
import { prState, summarizeChecks } from "@/lib/github-pull-request-summary"

describe("parsePullRequestUrl", () => {
  it("parses PR urls including sub-pages, queries and fragments", () => {
    expect(parsePullRequestUrl("https://github.com/acme/widgets/pull/209")).toEqual({ owner: "acme", repo: "widgets", number: 209 })
    expect(parsePullRequestUrl("https://github.com/o/r/pull/5/files?w=1#diff")).toEqual({ owner: "o", repo: "r", number: 5 })
  })
  it("rejects other hosts, issues, protocols and bad numbers", () => {
    for (const href of ["https://evil.com/o/r/pull/5", "https://github.com/o/r/issues/5", "http://github.com/o/r/pull/5", "https://github.com/o/r/pull/0", "https://github.com/o/r/pull/abc", "https://github.com/o/r", "/relative/pull/5"]) {
      expect(parsePullRequestUrl(href)).toBeNull()
    }
  })
})

describe("panel id", () => {
  it("round trips", () => {
    const ref = { owner: "o", repo: "r.x", number: 12 }
    expect(parsePullRequestPanelId(pullRequestPanelId(ref))).toEqual(ref)
  })
  it("rejects malformed ids", () => {
    for (const id of ["", "o/r", "o/r/1/2", "o/../1x", "o/r/-1"]) expect(parsePullRequestPanelId(id)).toBeNull()
  })
})

describe("prState", () => {
  it("prefers merged, then closed, then draft", () => {
    expect(prState({ state: "closed", merged: true })).toBe("merged")
    expect(prState({ state: "closed" })).toBe("closed")
    expect(prState({ state: "open", draft: true })).toBe("draft")
    expect(prState({ state: "open" })).toBe("open")
  })
})

describe("summarizeChecks", () => {
  it("reports none, passing, pending and failing", () => {
    expect(summarizeChecks([], []).checks).toBe("none")
    expect(summarizeChecks([{ name: "a", status: "completed", conclusion: "success" }], [{ context: "s", state: "success" }]).checks).toBe("passing")
    expect(summarizeChecks([{ name: "a", status: "in_progress" }], []).checks).toBe("pending")
    const failed = summarizeChecks([{ name: "a", status: "completed", conclusion: "failure" }, { name: "b", status: "in_progress" }], [])
    expect(failed).toEqual({ checks: "failing", failing: ["a"] })
  })
})
