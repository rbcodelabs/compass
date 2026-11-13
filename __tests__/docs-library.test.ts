import { describe, expect, it } from "vitest"
import { groupDocsByKind, kindCounts, parseLibraryView, recentDocs, type LibraryDoc } from "@/lib/docs-library"

const at = (iso: string) => new Date(`${iso}T12:00:00Z`)
const doc = (id: string, title: string, kind: string | null, updated: string): LibraryDoc => ({ id, title, kind, updatedAt: at(updated) })

const docs: LibraryDoc[] = [
  doc("a1", "ADR - Entity links", "ADR", "2026-11-01"),
  doc("a2", "ADR - Work item IDs", "ADR", "2026-11-05"),
  doc("q1", "QA Report - Gallery", "QA_REPORT", "2026-11-09"),
  doc("d1", "Design: GitHub repos", "DESIGN", "2026-11-03"),
  doc("n1", "Standup notes", "NOTE", "2026-11-04"),
  doc("u1", "Next steps", null, "2026-11-08"),
  doc("u2", "Pinned columns", null, "2026-11-02"),
  doc("x1", "Odd stored kind", "SPEC", "2026-11-06"),
]

describe("parseLibraryView", () => {
  it("defaults to overview and accepts by-type and recent", () => {
    expect(parseLibraryView(undefined)).toBe("overview")
    expect(parseLibraryView("overview")).toBe("overview")
    expect(parseLibraryView("by-type")).toBe("by-type")
    expect(parseLibraryView("recent")).toBe("recent")
  })

  it("falls back to overview for anything else, including repeated params", () => {
    expect(parseLibraryView("gallery")).toBe("overview")
    expect(parseLibraryView("")).toBe("overview")
    expect(parseLibraryView(["recent", "by-type"])).toBe("overview")
  })
})

describe("kindCounts", () => {
  it("counts each kind, with unset and unknown stored kinds under No type", () => {
    expect(kindCounts(docs)).toEqual({
      total: 8,
      byKind: [
        { kind: "ADR", label: "ADR", count: 2 },
        { kind: "QA_REPORT", label: "QA report", count: 1 },
        { kind: "DESIGN", label: "Design", count: 1 },
        { kind: "NOTE", label: "Note", count: 1 },
      ],
      noType: 3,
    })
  })

  it("keeps every kind at zero for an empty library", () => {
    const counts = kindCounts([])
    expect(counts.total).toBe(0)
    expect(counts.noType).toBe(0)
    expect(counts.byKind.map((row) => row.count)).toEqual([0, 0, 0, 0])
  })
})

describe("groupDocsByKind", () => {
  it("orders the groups ADR, QA report, Design, Note and puts No type last", () => {
    expect(groupDocsByKind(docs).map((group) => group.label)).toEqual(["ADR", "QA report", "Design", "Note", "No type"])
  })

  it("omits empty groups", () => {
    const groups = groupDocsByKind([doc("a1", "ADR - One", "ADR", "2026-11-01"), doc("u1", "Loose", null, "2026-11-02")])
    expect(groups.map((group) => group.kind)).toEqual(["ADR", null])
    expect(groupDocsByKind([])).toEqual([])
  })

  it("sorts each group by most recently updated, then title", () => {
    const groups = groupDocsByKind(docs)
    expect(groups[0].docs.map((d) => d.id)).toEqual(["a2", "a1"])
    const noType = groups[groups.length - 1]
    expect(noType.kind).toBeNull()
    expect(noType.docs.map((d) => d.id)).toEqual(["u1", "x1", "u2"])
    const tied = groupDocsByKind([doc("b", "Beta", "NOTE", "2026-11-01"), doc("a", "Alpha", "NOTE", "2026-11-01")])
    expect(tied[0].docs.map((d) => d.id)).toEqual(["a", "b"])
  })

  it("does not mutate its input", () => {
    const copy = [...docs]
    groupDocsByKind(docs)
    expect(docs).toEqual(copy)
  })
})

describe("recentDocs", () => {
  it("orders by updatedAt descending", () => {
    expect(recentDocs(docs).map((d) => d.id)).toEqual(["q1", "u1", "x1", "a2", "n1", "d1", "u2", "a1"])
  })

  it("limits the list, defaulting to 50", () => {
    expect(recentDocs(docs, 3).map((d) => d.id)).toEqual(["q1", "u1", "x1"])
    const many = Array.from({ length: 60 }, (_, index) => doc(`d${index}`, `Doc ${index}`, null, "2026-11-01"))
    expect(recentDocs(many)).toHaveLength(50)
  })

  it("does not mutate its input", () => {
    const copy = [...docs]
    recentDocs(docs, 2)
    expect(docs).toEqual(copy)
  })
})
