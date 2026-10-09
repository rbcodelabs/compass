import { describe, expect, it } from "vitest"
import { buildArtifactPresentation } from "@/lib/artifact-slides"
import { ARTIFACT_CSP } from "@/lib/artifact-preview-html"

const DECK = `<!doctype html><html><head><title>Deck</title></head><body>
<section class="slide" data-slide-title="Intro"><h1>One</h1></section>
<section class="slide"><h1>Two</h1></section>
</body></html>`

describe("buildArtifactPresentation", () => {
  it("leaves a DOCUMENT as one sandboxed document with no slides", () => {
    const result = buildArtifactPresentation(DECK, null)
    expect(result.slides).toBeUndefined()
    expect(result.html).toContain(ARTIFACT_CSP)
  })

  it("splits a SLIDE_DECK into individually sandboxed, zero-indexed slides", () => {
    const result = buildArtifactPresentation(DECK, "SLIDE_DECK")
    expect(result.slides?.map((slide) => slide.index)).toEqual([0, 1])
    expect(result.slides?.[0].title).toBe("Intro")
    expect(result.slides?.[0].html).toContain("One")
    expect(result.slides?.[0].html).not.toContain("Two")
    for (const slide of result.slides ?? []) expect(slide.html).toContain(ARTIFACT_CSP)
  })

  it("still yields one slide for a SLIDE_DECK with no slide markup", () => {
    const result = buildArtifactPresentation("<html><body><p>Just a page</p></body></html>", "SLIDE_DECK")
    expect(result.slides).toHaveLength(1)
    expect(result.slides?.[0].html).toContain("Just a page")
  })
})
