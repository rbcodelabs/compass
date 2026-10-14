import { describe, it, expect } from "vitest"
import { parseSlideDeck } from "@/lib/slide-parser"
import {
  MAX_SLIDE_DESCRIPTION_LENGTH,
  MAX_SLIDE_TITLE_LENGTH,
} from "@/lib/deck-contract"

/** Wraps body content in a minimal full HTML document. */
function doc(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head><title>Test Deck</title>${head}</head><body>${body}</body></html>`
}

/** Enough text that an <hr> fragment clears MIN_HR_CHUNK_TEXT_LENGTH. */
const LONG = "This slide has more than twenty characters of visible text."

describe("parseSlideDeck — detection formats", () => {
  it("detects a Reveal.js deck", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="reveal"><div class="slides">
          <section><h1>One</h1></section>
          <section><h1>Two</h1></section>
          <section><h1>Three</h1></section>
        </div></div>`
      )
    )
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides.map((s) => s.title)).toEqual(["One", "Two", "Three"])
  })

  it("detects .slide class divs", () => {
    const deck = parseSlideDeck(
      doc(`<div class="slide"><h2>Alpha</h2></div><div class="slide"><h2>Beta</h2></div>`)
    )
    expect(deck.slides).toHaveLength(2)
    expect(deck.slides.map((s) => s.title)).toEqual(["Alpha", "Beta"])
  })

  it("detects id=\"slide-N\" elements", () => {
    const deck = parseSlideDeck(
      doc(`<div id="slide-1"><h1>First</h1></div><div id="slide-2"><h1>Second</h1></div>`)
    )
    expect(deck.slides).toHaveLength(2)
    expect(deck.slides.map((s) => s.title)).toEqual(["First", "Second"])
  })

  it("detects top-level <section> children of body", () => {
    const deck = parseSlideDeck(
      doc(`<section><h1>S1</h1></section><section><h1>S2</h1></section>`)
    )
    expect(deck.slides).toHaveLength(2)
  })

  it("detects <section> nested one level inside a wrapper div", () => {
    // The regression the builder's server-side parser had: this collapsed to a
    // single slide there because it lacked the nested-section fallback.
    const deck = parseSlideDeck(
      doc(
        `<div class="slide-wrapper"><section><h1>Wrapped 1</h1></section></div>
         <div class="slide-wrapper"><section><h1>Wrapped 2</h1></section></div>
         <div class="slide-wrapper"><section><h1>Wrapped 3</h1></section></div>`
      )
    )
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides.map((s) => s.title)).toEqual([
      "Wrapped 1",
      "Wrapped 2",
      "Wrapped 3",
    ])
  })

  it("detects <hr>-separated chunks", () => {
    const deck = parseSlideDeck(
      doc(`<h1>A</h1><p>${LONG}</p><hr><h1>B</h1><p>${LONG}</p>`)
    )
    expect(deck.slides).toHaveLength(2)
    expect(deck.slides.map((s) => s.title)).toEqual(["A", "B"])
  })

  it("ignores a decorative <hr> that does not separate real content", () => {
    const deck = parseSlideDeck(doc(`<h1>Only</h1><p>${LONG}</p><hr><p>x</p>`))
    expect(deck.slides).toHaveLength(1)
  })

  it("falls back to the whole body as one slide", () => {
    const deck = parseSlideDeck(doc(`<main><h1>Just one page</h1><p>${LONG}</p></main>`))
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0].html).toContain("Just one page")
  })
})

describe("parseSlideDeck — detection priority", () => {
  it("prefers Reveal.js over other patterns present in the same document", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="reveal"><div class="slides">
           <section><h1>R1</h1></section><section><h1>R2</h1></section>
         </div></div>
         <div class="slide"><h1>Decoy A</h1></div>
         <div class="slide"><h1>Decoy B</h1></div>`
      )
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["R1", "R2"])
  })

  it("prefers .slide divs over an <hr> split", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="slide"><h1>C1</h1><p>${LONG}</p></div><hr>
         <div class="slide"><h1>C2</h1><p>${LONG}</p></div>`
      )
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["C1", "C2"])
  })

  it("only splits when a pattern yields more than one match", () => {
    // A lone .slide div must not short-circuit detection to a 1-slide result
    // when a later step (here, <hr>) would find real slides.
    const deck = parseSlideDeck(
      doc(`<div class="slide"><h1>A</h1><p>${LONG}</p><hr><h1>B</h1><p>${LONG}</p></div>`)
    )
    expect(deck.slides).toHaveLength(2)
  })
})

describe("parseSlideDeck — hidden slides", () => {
  it("un-hides slides hidden for JS-driven paging", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="slide"><h1>Visible</h1></div>
         <div class="slide" hidden style="display: none"><h1>Hidden</h1></div>`
      )
    )
    expect(deck.slides).toHaveLength(2)
    expect(deck.slides[1].html).not.toContain("hidden")
    expect(deck.slides[1].html).not.toMatch(/display:\s*none/)
  })

  // Regression: a real upload (a bespoke sidebar-nav presentation, not
  // authored to the deck-authoring spec) hid inactive slides with
  // `.slide { display: none }` plus a `.slide.active { display: block }`
  // override in its own <style> block, instead of per-element inline state.
  // That <style> is copied verbatim into every split slide's <head>, so
  // clearing each clone's *inline* style did nothing — every slide but the
  // one that happened to carry `.active` rendered blank. Detection must
  // refuse to split on a class that's hidden by default like this, so the
  // upload falls through to the single-page fallback instead of producing
  // blank pages.
  it("does not split slides hidden by a class rule in the shared <style>", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="slide active"><h1>One</h1></div>
         <div class="slide"><h1>Two</h1></div>
         <div class="slide"><h1>Three</h1></div>`,
        `<style>.slide{display:none}.slide.active{display:block}</style>`
      )
    )
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0].html).toContain("One")
    expect(deck.slides[0].html).toContain("Two")
    expect(deck.slides[0].html).toContain("Three")
  })

  it("still splits .slide divs when the shared <style> has no default-hidden rule", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="slide active"><h1>One</h1></div>
         <div class="slide"><h1>Two</h1></div>`,
        `<style>.slide{padding:8%}.slide.active{outline:2px solid red}</style>`
      )
    )
    expect(deck.slides).toHaveLength(2)
  })
})

describe("parseSlideDeck — head asset preservation", () => {
  const head = `
    <style>.brand { color: rebeccapurple }</style>
    <link rel="stylesheet" href="https://cdn.example.com/deck.css">
    <script src="https://cdn.tailwindcss.com"></script>
  `

  it("carries stylesheets, CDN links and CDN scripts into every slide", () => {
    const deck = parseSlideDeck(
      doc(`<section><h1>One</h1></section><section><h1>Two</h1></section>`, head)
    )
    for (const slide of deck.slides) {
      expect(slide.html).toContain("rebeccapurple")
      expect(slide.html).toContain("https://cdn.example.com/deck.css")
      expect(slide.html).toContain("https://cdn.tailwindcss.com")
    }
  })

  it("strips the deck's own paging scripts but keeps content scripts", () => {
    const deck = parseSlideDeck(
      doc(
        `<section><h1>One</h1></section><section><h1>Two</h1></section>
         <script>function nextSlide() { currentSlide++ }</script>
         <script>window.DECK_DATA = { rows: 3 }</script>`
      )
    )
    for (const slide of deck.slides) {
      expect(slide.html).not.toContain("nextSlide")
      expect(slide.html).toContain("DECK_DATA")
    }
  })

  // Regression: inline <head> scripts were dropped while inline <body> ones
  // were kept, so a deck defining a web component, a Tailwind config, or its
  // chart data in <head> rendered every slide differently from how the same
  // file renders as a flat page — silently, with no error anywhere.
  it("carries inline head scripts into every slide", () => {
    const deck = parseSlideDeck(
      doc(`<section><h1>One</h1></section><section><h1>Two</h1></section>`, [
        head,
        `<script>customElements.define("note-box", class extends HTMLElement {})</script>`,
        `<script>tailwind.config = { theme: { extend: {} } }</script>`,
      ].join("\n"))
    )
    for (const slide of deck.slides) {
      expect(slide.html).toContain("customElements.define")
      expect(slide.html).toContain("tailwind.config")
    }
  })

  it("applies the paging-script filter to head scripts too", () => {
    const deck = parseSlideDeck(
      doc(
        `<section><h1>One</h1></section><section><h1>Two</h1></section>`,
        `<script>function showSlide(n) { currentSlide = n }</script>`
      )
    )
    for (const slide of deck.slides) {
      expect(slide.html).not.toContain("showSlide")
    }
  })

  it("does not force overflow:hidden, which would clip tall slides", () => {
    // Deliberate divergence from the source implementation, which assumed a
    // fixed-size iframe. Quick Share serves slides as full pages.
    const deck = parseSlideDeck(doc(`<section><h1>A</h1></section><section><h1>B</h1></section>`))
    expect(deck.slides[0].html).not.toMatch(/overflow:\s*hidden/)
    expect(deck.slides[0].html).toContain("min-height: 100vh")
  })
})

describe("parseSlideDeck — titles and structure", () => {
  it("uses <title> for the deck title", () => {
    const deck = parseSlideDeck(doc(`<section><h1>A</h1></section><section><h1>B</h1></section>`))
    expect(deck.title).toBe("Test Deck")
  })

  it("falls back to the first <h1> when there is no <title>", () => {
    const deck = parseSlideDeck(
      `<html><head></head><body><h1>Heading Title</h1><p>${LONG}</p></body></html>`
    )
    expect(deck.title).toBe("Heading Title")
  })

  it("falls back to a placeholder deck title when nothing is available", () => {
    const deck = parseSlideDeck(`<html><head></head><body><p>${LONG}</p></body></html>`)
    expect(deck.title).toBe("Untitled deck")
  })

  // No positional "Slide 2" fallback: a fabricated label is indistinguishable
  // from a real one by the time it reaches a picker tile, so an unnamed slide
  // says so and the picker renders a plain numbered tile instead.
  it("leaves an untitled slide unnamed rather than naming it by position", () => {
    const deck = parseSlideDeck(doc(`<section><p>no heading</p></section><section><p>also none</p></section>`))
    expect(deck.slides.map((s) => s.title)).toEqual([null, null])
  })

  it("truncates an overlong slide title with an ellipsis", () => {
    const long = "T".repeat(120)
    const deck = parseSlideDeck(doc(`<section><h1>${long}</h1></section><section><h1>B</h1></section>`))
    // The ellipsis is inside the budget, not added on top of it: the result is
    // what a tile has to fit, so MAX_SLIDE_TITLE_LENGTH bounds the whole string.
    expect(deck.slides[0].title).toHaveLength(MAX_SLIDE_TITLE_LENGTH)
    expect(deck.slides[0].title?.endsWith("…")).toBe(true)
  })

  // A single unbroken run of characters has no word boundary to cut at, so it
  // falls back to a hard cut — the boundary search must not walk back so far
  // that it throws away most of the budget.
  it("cuts a title at a word boundary and drops the dangling punctuation", () => {
    const deck = parseSlideDeck(
      doc(
        `<section><h1>Enough of the fourteen jobs, and a referral fee becomes broker economics for everyone</h1></section>
         <section><h1>B</h1></section>`
      )
    )
    const title = deck.slides[0].title!
    expect(title.length).toBeLessThanOrEqual(MAX_SLIDE_TITLE_LENGTH)
    expect(title).toBe("Enough of the fourteen jobs, and a referral fee becomes…")
    // Never mid-word, and never a space or comma left stranded before the ellipsis.
    expect(title).not.toMatch(/[\s,;:.!?]…$/)
  })

  it("collapses a newline inside a heading before truncating it", () => {
    const deck = parseSlideDeck(
      doc(
        `<section><h1>\n        “Get me the best mortgage I can actually\n        qualify for”\n      </h1></section>
         <section><h1>B</h1></section>`
      )
    )
    const title = deck.slides[0].title!
    expect(title).not.toMatch(/\s{2,}|\n/)
    expect(title).toBe("“Get me the best mortgage I can actually qualify for”")
  })

  it("emits complete standalone documents with sequential indexes", () => {
    const deck = parseSlideDeck(
      doc(`<section><h1>A</h1></section><section><h1>B</h1></section><section><h1>C</h1></section>`)
    )
    expect(deck.slides.map((s) => s.index)).toEqual([0, 1, 2])
    for (const slide of deck.slides) {
      expect(slide.html).toMatch(/^<!DOCTYPE html>/)
      expect(slide.html).toContain("</body>")
      expect(slide.html).toContain("</html>")
    }
  })

  it("keeps each slide's content out of its siblings", () => {
    const deck = parseSlideDeck(
      doc(`<section><h1>Only-Alpha</h1></section><section><h1>Only-Beta</h1></section>`)
    )
    expect(deck.slides[0].html).toContain("Only-Alpha")
    expect(deck.slides[0].html).not.toContain("Only-Beta")
    expect(deck.slides[1].html).toContain("Only-Beta")
    expect(deck.slides[1].html).not.toContain("Only-Alpha")
  })
})

describe("parseSlideDeck — author-declared slide metadata", () => {
  it("prefers data-slide-title over the heading heuristic", () => {
    const deck = parseSlideDeck(
      doc(
        `<section data-slide-title="Revenue"><h1>The Numbers</h1></section>
         <section data-slide-title="Outlook"><h1>Continued</h1></section>`
      )
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["Revenue", "Outlook"])
  })

  it("reads data-slide-description, defaulting to null", () => {
    const deck = parseSlideDeck(
      doc(
        `<section data-slide-description="Revenue and margin by product line"><h1>A</h1></section>
         <section><h1>B</h1></section>`
      )
    )
    expect(deck.slides[0].description).toBe("Revenue and margin by product line")
    expect(deck.slides[1].description).toBeNull()
  })

  it("names a slide by heading when only a description is declared", () => {
    const deck = parseSlideDeck(
      doc(`<section data-slide-description="d"><h1>A</h1></section><section><h1>B</h1></section>`)
    )
    expect(deck.slides[0].title).toBe("A")
  })

  it("falls back to the heading for a blank or whitespace-only title", () => {
    const deck = parseSlideDeck(
      doc(`<section data-slide-title=""><h1>A</h1></section><section data-slide-title="   "><h1>B</h1></section>`)
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["A", "B"])
    expect(deck.slides.map((s) => s.description)).toEqual([null, null])
  })

  it("collapses whitespace in a wrapped attribute value", () => {
    const deck = parseSlideDeck(
      doc(`<section data-slide-title="Two\n     Lines"><h1>A</h1></section><section><h1>B</h1></section>`)
    )
    expect(deck.slides[0].title).toBe("Two Lines")
  })

  it("truncates an overlong declared title and description", () => {
    const deck = parseSlideDeck(
      doc(
        `<section data-slide-title="${"T".repeat(120)}" data-slide-description="${"D".repeat(300)}"><h1>A</h1></section>
         <section><h1>B</h1></section>`
      )
    )
    expect(deck.slides[0].title).toHaveLength(MAX_SLIDE_TITLE_LENGTH)
    expect(deck.slides[0].title?.endsWith("…")).toBe(true)
    expect(deck.slides[0].description).toHaveLength(MAX_SLIDE_DESCRIPTION_LENGTH)
    expect(deck.slides[0].description?.endsWith("…")).toBe(true)
  })

  // Each detection branch reaches the metadata differently — Reveal.js and the
  // <hr> split rewrap their content, so these are not redundant with the
  // <section> cases above.
  it("reads metadata from a Reveal.js section, whose attributes the rewrap drops", () => {
    const deck = parseSlideDeck(
      doc(
        `<div class="reveal"><div class="slides">
          <section data-slide-title="Intro" data-slide-description="Why we are here"><h1>One</h1></section>
          <section data-slide-title="Close"><h1>Two</h1></section>
        </div></div>`
      )
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["Intro", "Close"])
    expect(deck.slides[0].description).toBe("Why we are here")
  })

  it("reads metadata from .slide divs and id=\"slide-N\" elements", () => {
    const classDeck = parseSlideDeck(
      doc(`<div class="slide" data-slide-title="X"><h2>a</h2></div><div class="slide"><h2>b</h2></div>`)
    )
    expect(classDeck.slides.map((s) => s.title)).toEqual(["X", "b"])

    const idDeck = parseSlideDeck(
      doc(`<div id="slide-1" data-slide-title="Y"><h1>a</h1></div><div id="slide-2"><h1>b</h1></div>`)
    )
    expect(idDeck.slides.map((s) => s.title)).toEqual(["Y", "b"])
  })

  it("reads metadata from a <section> nested inside a wrapper div", () => {
    const deck = parseSlideDeck(
      doc(
        `<div><section data-slide-title="Nested"><h1>a</h1></section><section><h1>b</h1></section></div>`
      )
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["Nested", "b"])
  })

  it("leaves <hr> chunks without metadata, since they have no element to carry it", () => {
    const deck = parseSlideDeck(
      doc(`<h1>Alpha</h1><p>${LONG}</p><hr><h1>Beta</h1><p>${LONG}</p>`)
    )
    expect(deck.slides.map((s) => s.title)).toEqual(["Alpha", "Beta"])
    expect(deck.slides.map((s) => s.description)).toEqual([null, null])
  })

  it("carries no metadata on the single-document fallback", () => {
    const deck = parseSlideDeck(doc(`<p>${LONG}</p>`))
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0].description).toBeNull()
  })
})

describe("parseSlideDeck — robustness", () => {
  it("always returns at least one slide for degenerate input", () => {
    for (const input of ["", "<html></html>", "not html at all", "<body></body>"]) {
      expect(parseSlideDeck(input).slides.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("tolerates unclosed tags", () => {
    const deck = parseSlideDeck(`<html><body><div class="slide"><h1>A</h1><div class="slide"><h1>B</h1></body></html>`)
    expect(deck.slides.length).toBeGreaterThanOrEqual(1)
  })
})

describe("parseSlideDeck — slide-count cap", () => {
  /** Builds an `<hr>`-separated document that splits into `count` chunks. */
  function hrDocument(count: number): string {
    const fragment = "<p>Twenty-plus characters of visible text here.</p>"
    return `<html><head><title>T</title></head><body>${Array.from(
      { length: count },
      () => fragment
    ).join("<hr>")}</body></html>`
  }

  it("splits a deck that sits at the cap", () => {
    expect(parseSlideDeck(hrDocument(200)).slides).toHaveLength(200)
  })

  // Past the cap the detection is treated as wrong, so the upload collapses to
  // one document — bounding blob writes without discarding any content.
  it("falls back to a single document past the cap", () => {
    const deck = parseSlideDeck(hrDocument(201))
    expect(deck.slides).toHaveLength(1)
  })

  it("keeps every fragment's content in the single fallback document", () => {
    const html = `<html><body><p>First fragment, twenty-plus chars.</p>${Array.from(
      { length: 400 },
      (_u, i) => `<hr><p>Fragment ${i} with twenty-plus characters.</p>`
    ).join("")}<hr><p>Last fragment, twenty-plus chars.</p></body></html>`

    const deck = parseSlideDeck(html)

    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0].html).toContain("First fragment")
    expect(deck.slides[0].html).toContain("Fragment 399")
    expect(deck.slides[0].html).toContain("Last fragment")
  })

  // The amplification this cap exists to bound: without it, a sub-2MB upload
  // produced tens of megabytes across thousands of blob writes.
  it("bounds total output size for a pathological upload", () => {
    const head = `<style>${"/*x*/".repeat(1000)}</style>`
    const fragment = "<p>Twenty-plus characters of visible text here.</p>"
    const html = `<html><head><title>T</title>${head}</head><body>${Array.from(
      { length: 10000 },
      () => fragment
    ).join("<hr>")}</body></html>`

    const deck = parseSlideDeck(html)
    const outputBytes = deck.slides.reduce((sum, s) => sum + s.html.length, 0)

    expect(deck.slides).toHaveLength(1)
    expect(outputBytes).toBeLessThan(2 * html.length)
  })
})
