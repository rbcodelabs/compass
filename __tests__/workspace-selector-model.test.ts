import { describe, it, expect } from "vitest"

import {
  describeWorkspace,
  greetingFor,
  groupByOrg,
  hashName,
  hueFor,
  initialFor,
  matchesQuery,
  motifFor,
  pluralize,
  recentWorkspaces,
  visitedLabel,
  workspaceHref,
  workspaceKey,
  type SelectorWorkspace,
} from "@/components/workspace-selector/model"

function ws(over: Partial<SelectorWorkspace> & { name: string }): SelectorWorkspace {
  return {
    id: over.id ?? over.name,
    slug: over.name.toLowerCase().replace(/\W+/g, "-"),
    orgSlug: "acme",
    orgName: "Acme",
    ...over,
  }
}

describe("cover derivation", () => {
  it("is deterministic and matches the design's hash", () => {
    expect(hashName("")).toBe(7)
    expect(hashName("a")).toBe((7 * 31 + 97) >>> 0)
    expect(hashName("Mortgage Growth")).toBe(hashName("Mortgage Growth"))
  })

  it("picks hue and motif from the fixed palettes", () => {
    for (const n of ["Alpha", "Beta", "Mortgage Growth", "Ünïcode ✓"]) {
      expect([262, 18, 190, 150, 225, 340, 32, 285]).toContain(hueFor(n))
      expect(["dots", "stripes", "contours"]).toContain(motifFor(n))
    }
  })

  it("derives a safe initial", () => {
    expect(initialFor("compass")).toBe("C")
    expect(initialFor("  ")).toBe("?")
    expect(initialFor("😀 Fun")).toBe("😀")
  })
})

describe("keys and hrefs", () => {
  it("scopes identity by org since slugs are only unique per org", () => {
    expect(workspaceKey({ orgSlug: "a", slug: "x" })).not.toBe(workspaceKey({ orgSlug: "b", slug: "x" }))
    expect(workspaceHref({ orgSlug: "a", slug: "x" })).toBe("/a/x/okrs")
  })
})

describe("describeWorkspace", () => {
  it("composes the accessible name", () => {
    const w = ws({ name: "Home Equity", isReadOnly: true })
    expect(describeWorkspace(w, false)).toBe("Home Equity, Acme, read-only")
    expect(describeWorkspace(w, true)).toBe("Home Equity, Acme, current workspace, read-only")
  })
})

describe("matchesQuery", () => {
  const w = ws({ name: "Mortgage Growth", description: "Refinance journeys" })
  it("matches everything for a blank query", () => {
    expect(matchesQuery(w, "")).toBe(true)
    expect(matchesQuery(w, "   ")).toBe(true)
  })
  it("requires every token across name, description and org", () => {
    expect(matchesQuery(w, "mortgage acme")).toBe(true)
    expect(matchesQuery(w, "REFINANCE")).toBe(true)
    expect(matchesQuery(w, "mortgage insurance")).toBe(false)
  })
  it("tolerates a missing description", () => {
    expect(matchesQuery(ws({ name: "X", description: null }), "x")).toBe(true)
  })
})

describe("groupByOrg", () => {
  it("preserves first-seen org order and item order", () => {
    const list = [
      ws({ name: "A", orgSlug: "globex", orgName: "Globex" }),
      ws({ name: "B" }),
      ws({ name: "C", orgSlug: "globex", orgName: "Globex" }),
    ]
    const groups = groupByOrg(list)
    expect(groups.map((g) => g.orgSlug)).toEqual(["globex", "acme"])
    expect(groups[0].items.map((i) => i.name)).toEqual(["A", "C"])
  })
  it("returns no groups for an empty list", () => {
    expect(groupByOrg([])).toEqual([])
  })
})

describe("recentWorkspaces", () => {
  const list = [ws({ name: "A" }), ws({ name: "B" }), ws({ name: "C" }), ws({ name: "D" }), ws({ name: "E" })]
  it("orders by recency, drops never-visited, and limits", () => {
    const visits = {
      [workspaceKey(list[0])]: 100,
      [workspaceKey(list[1])]: 400,
      [workspaceKey(list[2])]: 300,
      [workspaceKey(list[3])]: 200,
    }
    expect(recentWorkspaces(list, visits).map((w) => w.name)).toEqual(["B", "C", "D"])
    expect(recentWorkspaces(list, visits, 1).map((w) => w.name)).toEqual(["B"])
  })
  it("is empty with no visits and does not mutate input order", () => {
    const copy = [...list]
    expect(recentWorkspaces(list, {})).toEqual([])
    expect(list).toEqual(copy)
  })
})

describe("visitedLabel", () => {
  const now = new Date(2026, 9, 6, 15, 0, 0).getTime()
  const daysAgo = (d: number) => new Date(2026, 9, 6 - d, 9, 0, 0).getTime()
  it.each([
    [undefined, "Never visited"],
    [0, "Today"],
    [1, "Yesterday"],
    [3, "3 days ago"],
    [7, "Last week"],
    [14, "2 weeks ago"],
    [30, "Last month"],
    [90, "3 months ago"],
  ])("labels %s days", (d, label) => {
    expect(visitedLabel(d === undefined ? undefined : daysAgo(d), now)).toBe(label)
  })
  it("clamps future timestamps to Today", () => {
    expect(visitedLabel(now + 86_400_000 * 3, now)).toBe("Today")
  })
})

describe("text helpers", () => {
  it("pluralizes", () => {
    expect(pluralize(1, "member")).toBe("1 member")
    expect(pluralize(0, "member")).toBe("0 members")
  })
  it("greets by hour", () => {
    expect(greetingFor(6)).toBe("Good morning")
    expect(greetingFor(12)).toBe("Good afternoon")
    expect(greetingFor(18)).toBe("Good evening")
  })
})
