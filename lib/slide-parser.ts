/**
 * Splits an uploaded HTML document into individual slide documents.
 *
 * In Compass: ported verbatim (imports aside) from Commenter / Quick Share
 * (`bankrate-prototypes/v0-comment-service-for-prototypes`, `src/lib/slide-parser.ts`).
 * Compass does not store slides separately: a SLIDE_DECK Artifact keeps the
 * whole uploaded document as its revision HTML, and this parser splits it at
 * read time. Each resulting slide document is rendered in the same sandboxed
 * Artifact frame as any other uploaded HTML, so the paragraph below about
 * Quick Share serving slides as top-level documents describes Commenter only.
 * Server-only (cheerio); keep it out of client bundles.
 *
 * Originally ported from v0-presentation-builder, which had two divergent
 * implementations of this logic — a client-side `DOMParser` version
 * (`utils/html-presentation-parser.ts`) and a server-side cheerio version
 * (inside its `create_presentation_from_html` MCP tool). They disagreed on
 * detection order, and the cheerio one was missing the nested-`<section>`
 * fallback entirely, so wrapper-div decks silently collapsed to one slide
 * when created through the API. This is the single unified implementation:
 * server-side only, cheerio, with every detection step both versions had.
 *
 * Deliberately NOT ported from the builder:
 *   - the sandboxed-iframe renderer and its `allow-scripts allow-same-origin`
 *     sandbox flags. Quick Share serves slides as top-level documents from a
 *     separate origin under a CSP `sandbox` header that omits
 *     `allow-same-origin` on purpose (F1, security review 2026-08-20), which
 *     is a strictly stronger boundary. Slides need no iframe here.
 *   - the fixed 960x540 canvas sizing. See `NORMALIZE_STYLE` below. Slides are
 *     still scaled to fit the viewport, but by measuring the deck's own canvas
 *     at render time rather than assuming one size — see `slide-fit.ts`.
 *
 * Detection priority (each step only runs if the previous produced <= 1 chunk):
 *   1. Reveal.js            — `.reveal .slides > section`
 *   2. `.slide` class divs  — common Claude artifact pattern
 *   3. `id="slide-N"` / `[data-slide]`
 *   4. `<section>` children of `<body>`, then nested `body > div > section`
 *   5. `<hr>`-separated body chunks
 *   6. Fallback — whole body as one slide
 *
 * Independently of which pattern matches, a slide element may carry
 * `data-slide-title` and `data-slide-description` to name and summarise itself
 * for the slide picker. See `TITLE_ATTR` below for why those are read during
 * detection rather than afterwards, and why pattern 5 is the one that cannot
 * support them.
 */
import * as cheerio from "cheerio"

/** A parsed DOM node, without a direct dependency on domhandler. */
type SlideNode = Exclude<Parameters<typeof cheerio.load>[0], string | Buffer | unknown[]>
import {
  MAX_SLIDE_DESCRIPTION_LENGTH,
  MAX_SLIDE_TITLE_LENGTH,
  MAX_SLIDES,
  SLIDE_DESCRIPTION_ATTR,
  SLIDE_TITLE_ATTR,
} from "@/lib/deck-contract"

export interface ParsedSlide {
  /**
   * Human-readable label, or `null` for a slide nobody named.
   *
   * The author's own `data-slide-title` when the slide carries one, else its
   * first heading, else null — see `headingTitle` for why the third case is not
   * a positional "Slide 3".
   */
  title: string | null
  /**
   * One-line summary from the author's `data-slide-description`, or `null`.
   *
   * Never inferred: unlike `title`, which falls back to the slide's first
   * heading, there is no honest way to derive a summary from slide content, and
   * a guessed one shown in the picker would be worse than none.
   */
  description: string | null
  /** Complete standalone HTML document for this slide. */
  html: string
  /** Zero-based position in the deck. */
  index: number
}

export interface ParsedDeck {
  /** Deck title, from `<title>` or the first `<h1>`. */
  title: string
  slides: ParsedSlide[]
}

/**
 * Reset injected into every slide document.
 *
 * The builder used `height: 100%; overflow: hidden` because its slides
 * rendered inside a fixed 960x540 iframe that was CSS-transform-scaled to
 * fit. Quick Share serves each slide as a full page instead, where
 * `overflow: hidden` would silently clip any slide taller than the viewport,
 * so this uses `min-height: 100vh` and leaves overflow alone. Everything
 * else (margin/padding reset, inherited box-sizing) carries over unchanged.
 */
const NORMALIZE_STYLE = `<style>
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  min-height: 100vh;
  box-sizing: border-box;
}
*, *::before, *::after { box-sizing: inherit; }
</style>`

/**
 * Scripts that drive the deck's *own* slide paging. Quick Share replaces
 * paging with real per-slide URLs, so leaving these in would fight the
 * server-rendered navigation (and, in JS-driven decks, re-hide every slide
 * but the first).
 */
const NAV_SCRIPT_PATTERN = /\b(currentSlide|showSlide|nextSlide|prevSlide|Reveal\.)\b/

/**
 * Classes shared by every element in a candidate slide set, used to check
 * whether the deck hides inactive slides via a CSS *class* rule rather than
 * per-element inline state.
 */
function sharedClasses($: CheerioApi, els: cheerio.Cheerio<SlideNode>): string[] {
  // Not `els.map(...).get()`: cheerio's `.map` (like jQuery's) flattens any
  // array a callback returns, so collecting a per-element string[] that way
  // silently merges every element's classes into one flat list instead of a
  // list of lists. Build it by hand with `.each` instead.
  const lists: string[][] = []
  els.each((_i, el) => {
    lists.push(($(el).attr("class") || "").split(/\s+/).filter(Boolean))
  })
  if (lists.length === 0) return []
  return lists[0].filter((cls) => lists.every((list) => list.includes(cls)))
}

/**
 * True when the document's own `<style>` rules hide every element carrying
 * one of `classNames` by default (`.slide { display: none }` plus a
 * `.slide.active { display: block }` override is the common shape — a
 * JS-driven single-page deck that manages its own paging via a CSS class
 * toggle instead of per-element `hidden`/inline `style`).
 *
 * This matters because that `<style>` block is copied verbatim into every
 * split slide's `<head>` (see `extractHeadContent`). Cloning a slide and
 * clearing its *inline* style (the existing un-hide step, below) cannot
 * override a *class* rule that ships in the shared head — every slide but
 * the one that happened to carry the active-state class would render
 * blank. Detection has to refuse the split rather than produce that, so the
 * upload falls through to later patterns and, ultimately, the single-page
 * fallback — exactly how it rendered before deck support existed.
 */
function hiddenByClassRule($: CheerioApi, classNames: string[]): boolean {
  if (classNames.length === 0) return false
  const styleText = $("style").text()
  return classNames.some((cls) => {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const rule = new RegExp(
      `\\.${escaped}(?![\\w-])[^{}]*\\{[^{}]*display\\s*:\\s*none`,
      "i"
    )
    return rule.test(styleText)
  })
}

/**
 * The metadata caps and attribute names, from the shared contract module because
 * `deck-authoring-prompt.ts` documents all four to the deck's author.
 *
 * The two attributes exist because the picker had nothing but a slide number to
 * show. A heading-derived title covers the common case, but plenty of slides open
 * with a heading that is useless as a label ("Continued", "The Numbers") or carry
 * no heading at all, and nothing at all could describe a slide beyond its title.
 *
 * They are read off the source ELEMENT during detection rather than re-parsed out
 * of the chunk HTML afterwards, which is what `headingTitle` has to do. That
 * is not a stylistic preference: the Reveal.js and `<hr>` branches below rewrap
 * their content in a layout `<div>`, and the Reveal one drops the original
 * `<section>`'s attributes on the floor when it does. Metadata read after the
 * fact would therefore be silently unavailable on exactly those decks.
 */
const MAX_TITLE_LENGTH = MAX_SLIDE_TITLE_LENGTH
const MAX_DESCRIPTION_LENGTH = MAX_SLIDE_DESCRIPTION_LENGTH
const TITLE_ATTR = SLIDE_TITLE_ATTR
const DESCRIPTION_ATTR = SLIDE_DESCRIPTION_ATTR

/**
 * Minimum visible-text length for an `<hr>`-delimited fragment to count as a
 * slide. Guards against a decorative `<hr>` inside a single slide being
 * mistaken for a slide divider.
 */
const MIN_HR_CHUNK_TEXT_LENGTH = 20

type CheerioApi = cheerio.CheerioAPI

/**
 * Collects the shared `<head>` payload every slide document needs: stylesheets,
 * CDN scripts, and inline scripts that define content (React components and the
 * like) rather than drive paging.
 */
function extractHeadContent($: CheerioApi): string {
  const parts: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  ]

  const passThrough = [
    "head style",
    'head link[rel="stylesheet"]',
    "head script[src]",
    // Some generators put CDN scripts at the end of <body> instead.
    "body script[src]",
  ]

  for (const selector of passThrough) {
    $(selector).each((_i, el) => {
      const html = $.html(el)
      if (html) parts.push(html)
    })
  }

  // Inline scripts from both <head> and <body>, in document order. Head ones
  // matter as much as body ones — a Tailwind config, a customElements.define,
  // or chart data all commonly live there, and dropping them renders every
  // slide differently from how the same file renders as a flat page.
  $("head script:not([src]), body script:not([src])").each((_i, el) => {
    const source = $(el).text() || ""
    if (NAV_SCRIPT_PATTERN.test(source)) return
    const html = $.html(el)
    if (html) parts.push(html)
  })

  parts.push(NORMALIZE_STYLE)

  return parts.join("\n")
}

/** Strips tags and collapses whitespace, for length/heading heuristics. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * One detected slide, before it is rebuilt into a standalone document.
 *
 * Carries the author's metadata alongside the body HTML because that metadata
 * is only reachable while the source element is still in hand — see the comment
 * on `TITLE_ATTR`.
 */
interface SlideChunk {
  /** Body content for this slide. */
  html: string
  /** Author-declared title, or `null` to fall back to a heading. */
  title: string | null
  /** Author-declared description, or `null`. */
  description: string | null
}

/** A chunk with no author metadata — the `<hr>` and whole-body branches. */
function bareChunk(html: string): SlideChunk {
  return { html, title: null, description: null }
}

/**
 * Trailing characters that must not be the last thing before an ellipsis: a
 * space (which renders as a visible gap in front of the dots), or a piece of
 * punctuation that was only ever a joint between two words — "the 14 jobs, …"
 * and "the 14 jobs …" both read as damage where "the 14 jobs…" reads as
 * shortening. Openers are included because a truncation that keeps a dangling
 * `(` or `“` promises a close that never comes.
 */
const TRAILING_PUNCTUATION = /[\s,;:.!?/\-–—("'“‘«]+$/

/**
 * The share of the budget a word boundary has to reach before it is preferred
 * over a hard cut.
 *
 * Without a floor, a single unbroken 60-character token (a URL, a hashed
 * filename) would fall back to its only space — possibly at character 3 —
 * and truncate a whole label away to "The…". Past this point the boundary is
 * close enough to the cap that the words lost to it are not missed.
 */
const WORD_BOUNDARY_FLOOR = 0.6

/**
 * Collapses whitespace, trims, and truncates to at most `max` characters,
 * returning `null` for anything with no visible text left.
 *
 * WHITESPACE. Both callers need the collapse and for the same reason, which is
 * why they share this rather than each trimming their own way. An author writes
 * these into an attribute or a heading by hand, where a wrapped line arrives
 * with its newline and indentation intact — and both survive into JSON and out
 * the other side into the picker's tile label, where a title renders as
 * `“Get me the best mortgage —\n      that I qualify for”`. The heading path
 * used to only `.trim()`, which strips the ends and leaves every interior
 * newline untouched; that is exactly what shipped and what a real deck showed.
 *
 * TRUNCATION. Cut at the last word boundary inside the budget rather than at a
 * fixed offset. A fixed offset lands mid-word — the shipped version produced
 * "…with best-execution r…" and "…becomes broker …" on a real deck — and an
 * ellipsis is meant to say "there is more of this", not "this string was
 * damaged". `max` bounds the RESULT including the ellipsis, so a caller's cap
 * is the width it actually has to render, not that minus three.
 */
function normalizeLabel(value: string | undefined | null, max: number): string | null {
  if (!value) return null
  const text = value.replace(/\s+/g, " ").trim()
  if (!text) return null
  if (text.length <= max) return text

  // One character of the budget belongs to the ellipsis itself.
  const clipped = text.slice(0, max - 1)
  const boundary = clipped.lastIndexOf(" ")
  const kept =
    boundary >= Math.floor((max - 1) * WORD_BOUNDARY_FLOOR)
      ? clipped.slice(0, boundary)
      : clipped
  return `${kept.replace(TRAILING_PUNCTUATION, "")}…`
}

/** Reads `data-slide-title` / `data-slide-description` off a slide element. */
function readSlideMeta(
  $: CheerioApi,
  el: SlideNode
): { title: string | null; description: string | null } {
  const $el = $(el)
  return {
    title: normalizeLabel($el.attr(TITLE_ATTR), MAX_TITLE_LENGTH),
    description: normalizeLabel($el.attr(DESCRIPTION_ATTR), MAX_DESCRIPTION_LENGTH),
  }
}

/**
 * Maps a set of detected slide elements to chunks, pairing each element's
 * rendered HTML with the metadata read from that same element.
 *
 * Built with `.each` rather than cheerio's `.map(...).get()` for the reason
 * spelled out in `sharedClasses` above: `.map` flattens what its callback
 * returns, and while an object survives that today it is not a property worth
 * depending on when `.each` is this cheap.
 */
function chunksFrom(
  $: CheerioApi,
  els: cheerio.Cheerio<SlideNode>,
  render: (el: SlideNode) => string
): SlideChunk[] {
  const chunks: SlideChunk[] = []
  els.each((_i, el) => {
    chunks.push({ html: render(el), ...readSlideMeta($, el) })
  })
  return chunks
}

/**
 * Renders a detected slide element as-is, after undoing the hiding that a
 * JS-driven deck applies to every slide but the active one.
 */
function renderUnhidden($: CheerioApi, el: SlideNode): string {
  const clone = $(el).clone()
  clone.removeAttr("hidden")
  clone.css("display", "")
  return $.html(clone)
}

/**
 * The slide's first heading as a label, or `null` when it has none.
 *
 * WHY NULL RATHER THAN "SLIDE 3"
 *
 * This used to fall back to a positional `Slide ${index + 1}`, and that string
 * was a lie told in the shape of a label. It survived the whole pipeline and
 * rendered in the picker as a tile reading "2" over "Slide 2" — a caption that
 * repeats the number above it and pushes the deck's real titles into a
 * needlessly tall grid. The escape hatch was a guard in `slide-meta.ts` that
 * dropped the metadata when EVERY title was positional, which is the case that
 * never happens: one slide in a deck of thirty without a heading is ordinary,
 * and that deck stored the placeholder.
 *
 * A missing label is now spelled `null` all the way through — parser, column,
 * `data-qs-slides`, tile — and the picker renders that one tile as a plain
 * number, which is what it has to say about a slide nobody named. Nothing
 * downstream has to recognise a magic string to tell a label from a placeholder,
 * because there is no longer a placeholder to recognise.
 */
function headingTitle(html: string): string | null {
  try {
    const $ = cheerio.load(html)
    return normalizeLabel($("h1, h2, h3").first().text(), MAX_TITLE_LENGTH)
  } catch {
    return null
  }
}

function buildStandaloneHtml(bodyContent: string, headContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${headContent}
</head>
<body>
${bodyContent}
</body>
</html>`
}

/**
 * Returns one chunk per detected slide. Never returns an empty array — the
 * final fallback is the whole body as a single slide.
 */
function detectSlideChunks($: CheerioApi): SlideChunk[] {
  // 1. Reveal.js deck.
  const revealSections = $(".reveal .slides > section")
  if (revealSections.length > 1) {
    // Recreate Reveal's centred layout so the slide reads correctly without
    // the Reveal.js runtime, which we strip along with the other nav scripts.
    //
    // This branch is why metadata is read from the element rather than from the
    // returned HTML: only the section's *inner* HTML survives into the chunk, so
    // its own `data-slide-title` would be gone by the time anything could look
    // for it. `chunksFrom` reads it before the rewrap.
    return chunksFrom($, revealSections, (el) => {
      const inner = $(el).html() ?? ""
      return `<div style="width:100%;min-height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:10% 8%;">${inner}</div>`
    })
  }

  // 2. Elements explicitly classed as slides.
  const slideDivs = $(
    '.slide, [class*="slide-page"], [class*="slide_page"], [data-slide-index]'
  )
  if (
    slideDivs.length > 1 &&
    !hiddenByClassRule($, sharedClasses($, slideDivs))
  ) {
    // Clone and un-hide: JS-driven decks hide every slide but the active one.
    return chunksFrom($, slideDivs, (el) => renderUnhidden($, el))
  }

  // 3. id="slide-N" / id="slideN" / [data-slide].
  const idSlides = $('[id^="slide"]:not([id="slide"]), [data-slide]')
  if (
    idSlides.length > 1 &&
    !hiddenByClassRule($, sharedClasses($, idSlides))
  ) {
    return chunksFrom($, idSlides, (el) => renderUnhidden($, el))
  }

  // 4. <section> elements: direct children of <body> first, then one level of
  //    nesting (the `<div class="slide-wrapper"><section>` pattern generators
  //    emit so a deck displays as a standalone file). cheerio has no `:scope`,
  //    so this walks children explicitly rather than porting the selector.
  const topSections = $("body").children("section")
  if (topSections.length > 1) {
    return chunksFrom($, topSections, (el) => $.html(el))
  }
  const nestedSections = $("body").children("div").children("section")
  if (nestedSections.length > 1) {
    return chunksFrom($, nestedSections, (el) => $.html(el))
  }

  // 5. <hr>-separated chunks (simple divider decks). Alone among the patterns,
  //    this one has no per-slide element to hang an attribute on — a slide here
  //    is the run of markup between two rules — so these chunks carry no
  //    author metadata and fall back to heading-derived titles.
  const bodyHtml = $("body").html() ?? ""
  if (/<hr\s*\/?>/i.test(bodyHtml)) {
    const parts = bodyHtml
      .split(/<hr\s*\/?>/i)
      .map((part) => part.trim())
      .filter((part) => visibleText(part).length > MIN_HR_CHUNK_TEXT_LENGTH)
    if (parts.length > 1) {
      return parts.map((part) =>
        bareChunk(
          `<div style="width:100%;min-height:100vh;padding:8% 10%;">${part}</div>`
        )
      )
    }
  }

  // 6. Fallback — the whole body is one slide.
  return [bareChunk(bodyHtml)]
}

/**
 * Parses an uploaded HTML document into a deck.
 *
 * Always returns at least one slide. A single-slide result means the upload
 * is an ordinary flat page, not a deck — callers decide what to do with that
 * (Quick Share stores it exactly as it always has).
 */
export function parseSlideDeck(html: string): ParsedDeck {
  const $ = cheerio.load(html)

  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "Untitled deck"

  const headContent = extractHeadContent($)

  // See MAX_SLIDES: an implausible chunk count means the detection was wrong,
  // so fall back to the whole body as one document rather than writing
  // thousands of blobs.
  const detected = detectSlideChunks($)
  const chunks =
    detected.length > MAX_SLIDES ? [bareChunk($("body").html() ?? "")] : detected

  return {
    title,
    slides: chunks.map((chunk, index) => ({
      // The author's own label wins over the heading heuristic. Only its
      // absence falls through — `normalizeLabel` has already turned a blank or
      // whitespace-only attribute into null, so `data-slide-title=""` behaves
      // as if it were never written rather than yielding an empty tile.
      title: chunk.title ?? headingTitle(chunk.html),
      description: chunk.description,
      html: buildStandaloneHtml(chunk.html, headContent),
      index,
    })),
  }
}
