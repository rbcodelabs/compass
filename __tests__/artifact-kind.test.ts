import { describe, expect, it } from "vitest"
import { assertKindAllowedForSource, parseArtifactKind, readArtifactKind, storedArtifactKind } from "@/lib/artifact-kind"

describe("artifact kind", () => {
  it("reads NULL and unknown stored values as DOCUMENT", () => {
    expect(readArtifactKind(null)).toBe("DOCUMENT")
    expect(readArtifactKind(undefined)).toBe("DOCUMENT")
    expect(readArtifactKind("CAROUSEL")).toBe("DOCUMENT")
    expect(readArtifactKind("SLIDE_DECK")).toBe("SLIDE_DECK")
  })

  it("parses caller input case-insensitively and rejects unknown values", () => {
    expect(parseArtifactKind(undefined)).toBeUndefined()
    expect(parseArtifactKind("")).toBeUndefined()
    expect(parseArtifactKind(" slide_deck ")).toBe("SLIDE_DECK")
    expect(parseArtifactKind("document")).toBe("DOCUMENT")
    expect(() => parseArtifactKind("deck")).toThrow("kind must be DOCUMENT or SLIDE_DECK")
    expect(() => parseArtifactKind(1)).toThrow("kind must be DOCUMENT or SLIDE_DECK")
  })

  it("stores DOCUMENT as NULL so there is one spelling of ordinary", () => {
    expect(storedArtifactKind("DOCUMENT")).toBeNull()
    expect(storedArtifactKind("SLIDE_DECK")).toBe("SLIDE_DECK")
  })

  it("allows a slide deck only for uploaded HTML", () => {
    expect(() => assertKindAllowedForSource("SLIDE_DECK", "HTML_UPLOAD")).not.toThrow()
    expect(() => assertKindAllowedForSource("DOCUMENT", "EXTERNAL_LINK")).not.toThrow()
    expect(() => assertKindAllowedForSource("SLIDE_DECK", "EXTERNAL_LINK")).toThrow("Only HTML upload artifacts can be slide decks")
  })
})
