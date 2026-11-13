import { describe, expect, it } from "vitest"
import { DOC_KINDS, DOC_KIND_LABELS, NO_KIND_LABEL, docKindLabel, isDocKind, normalizeDocKind } from "@/lib/doc-kinds"

describe("DOC_KINDS", () => {
  it("is exactly ADR, QA_REPORT, DESIGN, NOTE, in that order", () => {
    expect([...DOC_KINDS]).toEqual(["ADR", "QA_REPORT", "DESIGN", "NOTE"])
  })

  it("has no SPEC or PLAN kind (Spec and Discovery Plan docs keep their own docType)", () => {
    for (const forbidden of ["SPEC", "PLAN", "DISCOVERY_PLAN"]) expect(DOC_KINDS as readonly string[]).not.toContain(forbidden)
  })
})

describe("normalizeDocKind", () => {
  it.each(["ADR", "QA_REPORT", "DESIGN", "NOTE"])("keeps the known kind %s", (kind) => {
    expect(normalizeDocKind(kind)).toBe(kind)
  })

  it.each([null, undefined, "", "adr", "Adr", "SPEC", "PLAN", "STANDARD", " ADR", 7, {}, []])("reads %j as unset", (value) => {
    expect(normalizeDocKind(value)).toBeNull()
  })
})

describe("isDocKind", () => {
  it("accepts exactly the known kinds", () => {
    expect(DOC_KINDS.every((kind) => isDocKind(kind))).toBe(true)
    expect(isDocKind("SPEC")).toBe(false)
    expect(isDocKind(null)).toBe(false)
    expect(isDocKind(undefined)).toBe(false)
  })
})

describe("labels", () => {
  it("gives each kind the generic user-facing label", () => {
    expect(DOC_KIND_LABELS).toEqual({ ADR: "ADR", QA_REPORT: "QA report", DESIGN: "Design", NOTE: "Note" })
    expect(docKindLabel("QA_REPORT")).toBe("QA report")
    expect(NO_KIND_LABEL).toBe("No type")
  })

  it("labels an unset or unknown kind as No type", () => {
    expect(docKindLabel(null)).toBe("No type")
    expect(docKindLabel(undefined)).toBe("No type")
    expect(docKindLabel("SPEC")).toBe("No type")
  })

  it("never says Spec or Discovery Plan in user-facing text", () => {
    const text = [...Object.values(DOC_KIND_LABELS), NO_KIND_LABEL].join(" ")
    expect(text).not.toMatch(/spec|discovery plan/i)
  })
})
