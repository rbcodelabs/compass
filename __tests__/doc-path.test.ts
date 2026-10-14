import { describe, expect, it } from "vitest"
import { sanitizeTitleSegment, validateDocPath, isWikiExcludedSegment } from "@/lib/doc-path"

describe("sanitizeTitleSegment escapes names the sandbox's wiki walk skips", () => {
  it("escapes a leading dot so a doc is never hidden from the sandbox", () => {
    expect(sanitizeTitleSegment(".env")).toBe("_env")
    expect(sanitizeTitleSegment("..hidden")).toBe("__hidden")
    expect(sanitizeTitleSegment(".git")).toBe("_git")
  })

  it("escapes node_modules and the reserved _doc.md name", () => {
    expect(sanitizeTitleSegment("node_modules")).toBe("node_modules_")
    expect(sanitizeTitleSegment("_doc.md")).toBe("_doc.md_")
  })

  it("never yields a name the wiki would exclude, for a spread of hostile titles", () => {
    for (const title of [".", "..", "...", ".a", ". a", " .a", "node_modules", "node_modules.", "  node_modules  ", "_doc.md", ".\u0000x", "./x", "../x", "$HOME", "50% off", "%PATH%", "'quoted'", "\u0060tick\u0060", "tab\there", "nel\u0085x"]) {
      const out = sanitizeTitleSegment(title)
      expect(isWikiExcludedSegment(out), title).toBe(false)
      expect(out, title).not.toBe("_doc.md")
      expect(sanitizeTitleSegment(out), `${title} is idempotent`).toBe(out)
    }
  })

  it("escapes variable-expansion and quote characters the agent's file tools refuse", () => {
    expect(sanitizeTitleSegment("50% off")).toBe("50_ off")
    expect(sanitizeTitleSegment("$HOME")).toBe("_HOME")
    expect(sanitizeTitleSegment("'quoted'")).toBe("_quoted_")
    // interior apostrophes are ordinary
    expect(sanitizeTitleSegment("Rick's plan")).toBe("Rick's plan")
  })

  it("leaves ordinary titles alone", () => {
    expect(sanitizeTitleSegment("Q3 Plan")).toBe("Q3 Plan")
    expect(sanitizeTitleSegment("a.b")).toBe("a.b")
  })
})

describe("validateDocPath", () => {
  it("accepts paths the doc layer itself produces", () => {
    expect(validateDocPath("Product")).toBeNull()
    expect(validateDocPath("Product/Roadmap/Q3 Plan")).toBeNull()
    expect(validateDocPath("Notes (22222222)")).toBeNull()
    expect(validateDocPath("a.b/c")).toBeNull()
  })

  it.each([
    [""],
    ["/"],
    ["/abs"],
    ["a//b"],
    ["a/"],
    ["."],
    [".."],
    ["a/../b"],
    ["a/./b"],
    [".hidden"],
    ["a/.hidden/b"],
    ["a\0b"],
    ["a\u0001b"],
    ["a:b"],
    ["a\\b"],
    ["a*b"],
    ["node_modules"],
    ["a/node_modules/b"],
    ["_doc.md"],
    [" lead"],
    ["trail "],
    ["trailing."],
    ["x".repeat(201)],
    ["日".repeat(70)],
    ["50%"],
    ["$HOME"],
    ["'quoted'"],
    ["nel\u0085x"],
  ])("rejects %j", (path) => {
    expect(validateDocPath(path)).not.toBeNull()
  })

  it("rejects non-strings, over-long paths and over-deep paths", () => {
    expect(validateDocPath(undefined)).not.toBeNull()
    expect(validateDocPath(42)).not.toBeNull()
    expect(validateDocPath(Array.from({ length: 5000 }, () => "a").join("/"))).not.toBeNull()
    expect(validateDocPath(Array.from({ length: 31 }, () => "a").join("/"))).not.toBeNull()
    expect(validateDocPath(Array.from({ length: 30 }, () => "a").join("/"))).toBeNull()
  })
})
