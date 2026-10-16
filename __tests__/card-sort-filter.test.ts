import { describe, expect, it } from "vitest"

import { matchesQuickFilter } from "@/lib/card-sort-filter"

describe("matchesQuickFilter", () => {
  it("matches everything on an empty or whitespace query", () => {
    expect(matchesQuickFilter(["Anything"], "")).toBe(true)
    expect(matchesQuickFilter(["Anything"], "   ")).toBe(true)
  })

  it("requires every term, in any order, across any field", () => {
    expect(matchesQuickFilter(["Slow CSV exports", null], "export slow")).toBe(true)
    expect(matchesQuickFilter(["Slow CSV exports", "Growth Squad"], "growth csv")).toBe(true)
    expect(matchesQuickFilter(["Slow CSV exports"], "slow pdf")).toBe(false)
  })

  it("ignores missing fields", () => {
    expect(matchesQuickFilter([null, undefined, "Title"], "title")).toBe(true)
  })
})
