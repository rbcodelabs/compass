import { describe, expect, it } from "vitest"

import {
  formatPullRequestLabel,
  isBarePullRequestLabel,
  parsePullRequestPanelId,
  parsePullRequestUrl,
  pullRequestPanelId,
  samePullRequest,
} from "@/lib/github-pull-request-links"
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

describe("bare PR label detection and formatting", () => {
  const pr = { owner: "acme", repo: "widgets", number: 209 }
  const href = "https://github.com/acme/widgets/pull/209"

  it("recognizes bare PR URLs and matching sub-page URLs", () => {
    expect(samePullRequest(pr, { owner: "ACME", repo: "Widgets", number: 209 })).toBe(true)
    expect(samePullRequest(pr, { owner: "acme", repo: "widgets", number: 210 })).toBe(false)
    expect(isBarePullRequestLabel(href, pr, href)).toBe(true)
    expect(isBarePullRequestLabel(`  ${href}/files  `, pr, `${href}/files`)).toBe(true)
    expect(isBarePullRequestLabel("https://github.com/ACME/widgets/pull/209", pr, href)).toBe(true)
    expect(isBarePullRequestLabel("", pr, href)).toBe(true)
  })

  it("preserves custom link text and rejects different PR URLs", () => {
    expect(isBarePullRequestLabel("PR #209", pr, href)).toBe(false)
    expect(isBarePullRequestLabel("#209 Fix auth redirect", pr, href)).toBe(false)
    expect(isBarePullRequestLabel("auth fix", pr, href)).toBe(false)
    expect(isBarePullRequestLabel("https://github.com/acme/widgets/pull/210", pr, href)).toBe(false)
    expect(isBarePullRequestLabel("https://github.com/other/widgets/pull/209", pr, href)).toBe(false)
  })

  it("formats #<number> <Title> without duplicating #<number>", () => {
    expect(formatPullRequestLabel({ number: 209, title: "Fix auth redirect" })).toBe("#209 Fix auth redirect")
    expect(formatPullRequestLabel({ number: 209, title: "  Trimmed title  " })).toBe("#209 Trimmed title")
    expect(formatPullRequestLabel({ number: 209, title: "#209" })).toBe("#209")
    expect(formatPullRequestLabel({ number: 209, title: "" })).toBe("#209")
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
