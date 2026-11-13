import { describe, expect, it } from "vitest"
import { classifyDocKind } from "@/lib/doc-kind-backfill"
import type { DocKind } from "@/lib/doc-kinds"
import { EXPECTED_COUNTS, REAL_DOC_ROWS as rows } from "./helpers/doc-kind-real-paths"

describe("the real-path table itself", () => {
  it("lists 49 distinct paths", () => {
    expect(rows).toHaveLength(EXPECTED_COUNTS.total)
    expect(new Set(rows.map((row) => row.path)).size).toBe(EXPECTED_COUNTS.total)
  })

  it("carries the hand-derived counts: 17 ADR, 8 QA_REPORT, 3 DESIGN, 21 unset", () => {
    const count = (kind: DocKind | null) => rows.filter((row) => row.expected === kind).length
    expect(count("ADR")).toBe(EXPECTED_COUNTS.ADR)
    expect(count("QA_REPORT")).toBe(EXPECTED_COUNTS.QA_REPORT)
    expect(count("DESIGN")).toBe(EXPECTED_COUNTS.DESIGN)
    expect(count(null)).toBe(EXPECTED_COUNTS.unset)
  })
})

describe("classifyDocKind over the real workspace paths", () => {
  it.each(rows.map((row) => [row.path, row] as const))("%s", (_path, row) => {
    expect(classifyDocKind({ title: row.title, parentTitle: row.parent })).toBe(row.expected)
  })

  it("classifies exactly the expected number of docs per kind", () => {
    const tally = { ADR: 0, QA_REPORT: 0, DESIGN: 0, NOTE: 0, unset: 0 }
    for (const row of rows) {
      const kind = classifyDocKind({ title: row.title, parentTitle: row.parent })
      tally[kind ?? "unset"] += 1
    }
    expect(tally).toEqual({ ADR: 17, QA_REPORT: 8, DESIGN: 3, NOTE: 0, unset: 21 })
  })
})

describe("classifyDocKind rules", () => {
  const classify = (title: string, parentTitle: string | null = null) => classifyDocKind({ title, parentTitle })

  it("matches ADR case-insensitively at a word boundary only", () => {
    expect(classify("adr - lower case")).toBe("ADR")
    expect(classify("ADR")).toBe("ADR")
    expect(classify("ADR-0007")).toBe("ADR")
    expect(classify("ADRENALINE rush")).toBeNull()
    expect(classify("Notes on ADR 12")).toBeNull()
  })

  it("matches a zero-padded four digit number prefix followed by a space, dot, colon or dash", () => {
    for (const title of ["0018 Title", "0018. Title", "0018: Title", "0018-Title"]) expect(classify(title)).toBe("ADR")
    for (const title of ["018 Title", "00180 Title", "0018Title", "2026/11 Title"]) expect(classify(title)).toBeNull()
  })

  it("does not read a year or year-like title prefix as an ADR number", () => {
    for (const title of ["2026 Roadmap", "2026 Planning notes", "2025: Year in review", "2026-Q1 plan", "1999 retrospective", "1018 Something"]) expect(classify(title), title).toBeNull()
  })

  it("does not read an ISO-date title prefix as an ADR number (a dated note stays unset)", () => {
    for (const title of ["2026-11-07 Agent chat run-status cleanup", "2026-11-07", "2026-11 Planning notes"]) expect(classify(title)).toBeNull()
    expect(classify("2026-11-07 Agent chat run-status cleanup", "QA")).toBeNull()
  })

  it("matches QA Report titles anywhere and the QA Reports parent only", () => {
    expect(classify("qa report - x")).toBe("QA_REPORT")
    expect(classify("Anything", "QA Reports")).toBe("QA_REPORT")
    expect(classify("Anything", "QA")).toBeNull()
  })

  it("matches Design by parent, or by a Design: / Design_ title", () => {
    expect(classify("Anything", "Design")).toBe("DESIGN")
    expect(classify("Anything", "Designs")).toBe("DESIGN")
    expect(classify("Design: Checkout flow")).toBe("DESIGN")
    expect(classify("Design_ Checkout flow")).toBe("DESIGN")
    expect(classify("Designing in public")).toBeNull()
  })

  it("lets the first matching rule win: an ADR title under QA Reports is an ADR", () => {
    expect(classify("ADR - Something", "QA Reports")).toBe("ADR")
    expect(classify("QA Report - Something", "Designs")).toBe("QA_REPORT")
  })

  it("leaves container pages, Spec and Discovery Plan docs unset", () => {
    for (const title of ["Architecture Decisions", "Decisions", "Architecture", "QA Reports", "QA", "Security", "Product", "Design", "Specs"]) {
      expect(classify(title)).toBeNull()
    }
    expect(classify("Spec - Checkout")).toBeNull()
    expect(classify("Discovery Plan - Onboarding")).toBeNull()
  })
})
