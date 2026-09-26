import { describe, it, expect } from "vitest"
import { deriveSlug, SLUG_PATTERN } from "@/lib/slug"

describe("deriveSlug", () => {
  it("lowercases, collapses runs of non-alphanumerics, and trims hyphens", () => {
    expect(deriveSlug("Product Team")).toBe("product-team")
    expect(deriveSlug("  Acme Corp!!  ")).toBe("acme-corp")
    expect(deriveSlug("R&D — Growth / 2026")).toBe("r-d-growth-2026")
    expect(deriveSlug("already-a-slug")).toBe("already-a-slug")
  })

  it("returns the empty string when nothing survives and no fallback is given", () => {
    // The onboarding org-slug field relies on this: the user sees a blank
    // field rather than a value they never typed.
    expect(deriveSlug("")).toBe("")
    expect(deriveSlug("!!!")).toBe("")
    expect(deriveSlug("日本語")).toBe("")
  })

  it("substitutes the fallback when nothing survives", () => {
    expect(deriveSlug("日本語", "workspace")).toBe("workspace")
    expect(deriveSlug("", "workspace")).toBe("workspace")
    // A non-empty result is never replaced by the fallback.
    expect(deriveSlug("Product Team", "workspace")).toBe("product-team")
  })

  it("produces output that satisfies SLUG_PATTERN whenever it is non-empty", () => {
    for (const input of ["Product Team", "R&D — Growth / 2026", "  __weird__  ", "日本語"]) {
      const slug = deriveSlug(input, "workspace")
      expect(SLUG_PATTERN.test(slug)).toBe(true)
    }
  })
})
