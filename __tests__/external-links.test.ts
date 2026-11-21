import { describe, expect, it } from "vitest"

import {
  displayKey,
  isExternalLinkProvider,
  isExternalLinkRelation,
  isExternalLinkSubjectType,
  parseExternalLink,
  providerLabel,
} from "@/lib/external-links"

describe("parseExternalLink: GitHub", function () {
  it("recognises a pull request, drops sub-pages and fragments, and lower-cases the key only", function () {
    const parsed = parseExternalLink("https://github.com/Acme/Web/pull/482/files?w=1#diff")
    expect(parsed).toEqual({
      provider: "GITHUB_PR",
      url: "https://github.com/Acme/Web/pull/482",
      externalKey: "acme/web#482",
      title: "Acme/Web #482",
      defaultRelation: "IMPLEMENTS",
    })
  })

  it("treats two spellings of the same PR as one key", function () {
    const a = parseExternalLink("https://github.com/acme/web/pull/7")
    const b = parseExternalLink("https://github.com/ACME/WEB/pull/7/commits")
    expect(a?.externalKey).toBe(b?.externalKey)
  })

  it("recognises an issue", function () {
    const parsed = parseExternalLink("https://github.com/acme/web/issues/12")
    expect(parsed?.provider).toBe("GITHUB_ISSUE")
    expect(parsed?.externalKey).toBe("acme/web#12")
    expect(parsed?.defaultRelation).toBe("TRACKS")
  })

  it("keeps other github.com pages as plain links", function () {
    expect(parseExternalLink("https://github.com/acme/web")?.provider).toBe("OTHER")
    expect(parseExternalLink("https://github.com/acme/web/pull/0")?.provider).toBe("OTHER")
    expect(parseExternalLink("https://github.com/acme/web/issues/abc")?.provider).toBe("OTHER")
  })
})

describe("parseExternalLink: Jira, Figma, Google, Slack", function () {
  it("recognises a Jira Cloud issue and keys it by site", function () {
    const parsed = parseExternalLink("https://Acme.atlassian.net/browse/PROJ-456?focusedCommentId=9")
    expect(parsed).toEqual({
      provider: "JIRA_ISSUE",
      url: "https://acme.atlassian.net/browse/PROJ-456",
      externalKey: "acme/PROJ-456",
      title: "PROJ-456",
      defaultRelation: "TRACKS",
    })
    expect(displayKey("JIRA_ISSUE", "acme/PROJ-456")).toBe("PROJ-456")
    expect(displayKey("GITHUB_PR", "acme/web#1")).toBe("acme/web#1")
  })

  it("does not treat other atlassian.net pages or bad keys as Jira issues", function () {
    expect(parseExternalLink("https://acme.atlassian.net/jira/software/projects/PROJ/boards/1")?.provider).toBe("OTHER")
    expect(parseExternalLink("https://acme.atlassian.net/browse/proj-1")?.provider).toBe("OTHER")
    expect(parseExternalLink("https://acme.atlassian.net/browse/PROJ-1/extra")?.provider).toBe("OTHER")
  })

  it("recognises Figma files and rebuilds the URL", function () {
    const parsed = parseExternalLink("https://figma.com/design/AbCdEfGhIjKl/My-flow?node-id=1-2")
    expect(parsed?.provider).toBe("FIGMA")
    expect(parsed?.url).toBe("https://www.figma.com/design/AbCdEfGhIjKl")
    expect(parsed?.externalKey).toBe("AbCdEfGhIjKl")
    expect(parsed?.defaultRelation).toBe("DESIGN")
  })

  it("recognises Google Docs by file id and drops the fragment", function () {
    const parsed = parseExternalLink("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit#heading=h.1")
    expect(parsed?.provider).toBe("GOOGLE_DRIVE")
    expect(parsed?.externalKey).toBe("1AbCdEfGhIjKlMnOp")
    expect(parsed?.url.includes("#")).toBe(false)
    expect(parsed?.defaultRelation).toBe("DOCS")
  })

  it("recognises a Slack message link", function () {
    const parsed = parseExternalLink("https://acme.slack.com/archives/C01234567AB/p1700000000123456?thread_ts=1")
    expect(parsed?.provider).toBe("SLACK_THREAD")
    expect(parsed?.url).toBe("https://acme.slack.com/archives/C01234567AB/p1700000000123456")
    expect(parsed?.externalKey).toBe("acme/C01234567AB/p1700000000123456")
    expect(parsed?.defaultRelation).toBe("DISCUSSION")
  })
})

describe("parseExternalLink: other links and safety", function () {
  it("stores an unknown https host as an inert OTHER link without hash or trailing slash", function () {
    const parsed = parseExternalLink("https://Example.com/spec/v2/?a=1#top")
    expect(parsed?.provider).toBe("OTHER")
    expect(parsed?.url).toBe("https://example.com/spec/v2?a=1")
    expect(parsed?.externalKey).toBe("https://example.com/spec/v2?a=1")
    expect(parsed?.title).toBe("example.com/spec/v2")
    expect(parsed?.defaultRelation).toBe("RELATED")
  })

  it("does not let a look-alike host pass as GitHub", function () {
    expect(parseExternalLink("https://github.com.evil.example/acme/web/pull/1")?.provider).toBe("OTHER")
    expect(parseExternalLink("https://notgithub.com/acme/web/pull/1")?.provider).toBe("OTHER")
  })

  it("rejects anything that is not a plain https URL", function () {
    const bad = [
      "http://github.com/acme/web/pull/1",
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://example.com/a",
      "https://user:pass@example.com/a",
      "https://example.com:8443/a",
      "https://localhost/a",
      "https://example.com./a",
      "not a url",
      "/relative/path",
      "",
      "   ",
    ]
    for (const value of bad) expect(parseExternalLink(value)).toBeNull()
    expect(parseExternalLink(null)).toBeNull()
    expect(parseExternalLink(undefined)).toBeNull()
  })

  it("rejects URLs too long to store", function () {
    const long = "https://example.com/" + "a".repeat(1100)
    expect(parseExternalLink(long)).toBeNull()
    expect(parseExternalLink("https://example.com/" + "a".repeat(5000))).toBeNull()
  })

  it("trims surrounding whitespace", function () {
    expect(parseExternalLink("  https://github.com/acme/web/pull/3  \n")?.externalKey).toBe("acme/web#3")
  })
})

describe("vocabulary guards", function () {
  it("accepts only known providers, relations and subject types", function () {
    expect(isExternalLinkProvider("JIRA_ISSUE")).toBe(true)
    expect(isExternalLinkProvider("JIRA")).toBe(false)
    expect(isExternalLinkRelation("DESIGN")).toBe(true)
    expect(isExternalLinkRelation("design")).toBe(false)
    expect(isExternalLinkSubjectType("TASK")).toBe(true)
    expect(isExternalLinkSubjectType("OPPORTUNITY")).toBe(false)
    expect(providerLabel("GITHUB_PR")).toBe("GitHub pull request")
  })
})
