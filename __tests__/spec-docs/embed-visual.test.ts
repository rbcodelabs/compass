import { describe, expect, it } from "vitest"
import { DOC_EMBED_KINDS } from "@/lib/doc-embeds"
import { cardEditSpec } from "@/lib/spec-docs/card-edit"
import { peekFact, statusVisual } from "@/lib/spec-docs/embed-visual"

describe("statusVisual", () => {
  it("covers every status a card can edit, so the compact row never shows a text pill for a known value", () => {
    for (const kind of DOC_EMBED_KINDS) {
      for (const status of cardEditSpec(kind)?.statuses ?? []) expect(statusVisual(kind, status), `${kind} ${status}`).not.toBeNull()
    }
  })

  it("maps representative values to a glyph, tone and label", () => {
    expect(statusVisual("task", "IN_PROGRESS")).toEqual({ glyph: "progress", tone: "progress", label: "In progress" })
    expect(statusVisual("task", "BLOCKED")).toEqual({ glyph: "blocked", tone: "danger", label: "Blocked" })
    expect(statusVisual("solution", "SHIPPED")).toMatchObject({ glyph: "done", tone: "done" })
    expect(statusVisual("solution", "VALIDATED")).toMatchObject({ glyph: "validated" })
    expect(statusVisual("objective", "AT_RISK")).toMatchObject({ glyph: "atRisk", tone: "warn" })
    expect(statusVisual("metric", "stale")).toMatchObject({ glyph: "stale", tone: "warn" })
    expect(statusVisual("artifact", "ARCHIVED")).toMatchObject({ glyph: "archived" })
  })

  it("is per kind: the same word can mean different things", () => {
    expect(statusVisual("opportunity", "ACTIVE")?.glyph).toBe("active")
    expect(statusVisual("task", "ACTIVE")).toBeNull()
  })

  it("returns null for no status, an empty status, a kind without statuses, and an unknown value", () => {
    expect(statusVisual("task", null)).toBeNull()
    expect(statusVisual("task", "")).toBeNull()
    expect(statusVisual("keyResult", "ACTIVE")).toBeNull()
    expect(statusVisual("doc", "ACTIVE")).toBeNull()
    expect(statusVisual("solution", "SOMETHING_NEW")).toBeNull()
  })
})

describe("peekFact", () => {
  const facts = [{ label: "Conclusion", value: "Won" }, { label: "Ends", value: "2026-11-14" }]
  it("picks the preferred fact per kind, with its label unless the value describes itself", () => {
    expect(peekFact("experiment", facts)).toBe("Ends 2026-11-14")
    expect(peekFact("experiment", [facts[0]])).toBe("Conclusion Won")
    expect(peekFact("metric", [{ label: "Latest", value: "3.1%" }])).toBe("3.1%")
    expect(peekFact("roadmapItem", [{ label: "Horizon", value: "Next" }])).toBe("Next")
    expect(peekFact("opportunity", [{ label: "Segment", value: "x" }, { label: "Score", value: "82%" }])).toBe("Score 82%")
  })
  it("is null when the card has none of the preferred facts", () => {
    expect(peekFact("opportunity", [{ label: "Segment", value: "x" }])).toBeNull()
    expect(peekFact("task", [])).toBeNull()
  })
})
