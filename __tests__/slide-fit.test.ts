// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildArtifactPresentation } from "@/lib/artifact-slides"
import { SLIDE_FIT_SETTLED_EVENT, slideFitPrelude, slideFitScript, withSlideFit } from "@/lib/slide-fit"

/** Runs an emitted `<script>…</script>` string in the current jsdom window. */
function run(scriptTag: string) {
  const body = scriptTag.replace(/^<script>/, "").replace(/<\/script>$/, "")
  new Function(body)()
}

/**
 * jsdom does no layout, so give every element the box we declare via
 * data-w/data-h and the viewport a fixed client size.
 */
function stubLayout(viewport: { w: number; h: number }) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    // data-fluid elements are width:100%: they follow an explicit html width (the fluid probe).
    if (this.dataset.fluid !== undefined) return parseFloat(document.documentElement.style.width) || viewport.w
    return Number(this.dataset.w ?? 0)
  })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.h ?? 0)
  })
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this === document.documentElement ? viewport.w : 0
  })
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this === document.documentElement ? viewport.h : 0
  })
}

function mountSlide(html: string) {
  document.documentElement.removeAttribute("style")
  document.documentElement.removeAttribute("data-compass-fit")
  document.body.innerHTML = html
}

describe("slide fit", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete (window as { __compassSlideReveal?: unknown }).__compassSlideReveal
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("emits plain scripts with no backticks", () => {
    expect(slideFitPrelude()).not.toContain("`")
    expect(slideFitScript()).not.toContain("`")
  })

  it("hides the document until fitted, with a backstop reveal", () => {
    run(slideFitPrelude())
    expect(document.documentElement.style.visibility).toBe("hidden")
    vi.advanceTimersByTime(2500)
    expect(document.documentElement.style.visibility).toBe("")
  })

  it("scales a fixed 1280x720 canvas up to fill and centres it in a larger viewport", () => {
    stubLayout({ w: 1920, h: 1200 })
    mountSlide(`<div class="slide" data-w="1280" data-h="720"></div><div data-w="40" data-h="40"></div>`)
    run(slideFitPrelude())
    run(slideFitScript())
    vi.advanceTimersByTime(1000) // past the entrance
    const root = document.querySelector<HTMLElement>(".slide")!
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("fitted")
    expect(root.style.position).toBe("fixed")
    // scale = min(1920/1280, 1200/720) = 1.5; height 1080, so 60px top and bottom.
    expect(root.style.transform).toBe("translate(0px, 60px) scale(1.5)")
  })

  it("letterboxes horizontally when the viewport is wider than the slide's aspect", () => {
    stubLayout({ w: 1000, h: 360 })
    mountSlide(`<div class="slide" data-w="1280" data-h="720"></div>`)
    run(slideFitScript())
    vi.advanceTimersByTime(1000)
    // scale = min(1000/1280, 360/720) = 0.5; width 640, so 180px each side.
    expect(document.querySelector<HTMLElement>(".slide")!.style.transform).toBe("translate(180px, 0px) scale(0.5)")
  })

  it("re-fits on resize", () => {
    const viewport = { w: 1280, h: 720 }
    stubLayout(viewport)
    mountSlide(`<div class="slide" data-w="1280" data-h="720"></div>`)
    // Not fluid: the slide is fixed at 1280, measured once, before the resize.
    viewport.w = 1400
    run(slideFitScript())
    viewport.w = 640
    viewport.h = 360
    vi.advanceTimersByTime(1000)
    window.dispatchEvent(new Event("resize"))
    expect(document.querySelector<HTMLElement>(".slide")!.style.transform).toBe("translate(0px, 0px) scale(0.5)")
  })

  it("leaves a fluid slide alone, and still reveals it", () => {
    stubLayout({ w: 1200, h: 800 })
    mountSlide(`<main data-fluid data-h="2000"></main>`)
    run(slideFitPrelude())
    run(slideFitScript())
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("fluid")
    expect(document.querySelector<HTMLElement>("main")!.style.transform).toBe("")
    expect(document.documentElement.style.visibility).toBe("")
    // The probe width is restored.
    expect(document.documentElement.style.width).toBe("")
    expect(document.body.style.width).toBe("")
  })

  it("fits a fixed canvas whose width happens to equal the viewport's", () => {
    // A 960x540 slide in a 960px-wide frame: equal widths, but it is not fluid.
    stubLayout({ w: 960, h: 800 })
    mountSlide(`<div class="slide" data-w="960" data-h="540"></div>`)
    run(slideFitPrelude())
    run(slideFitScript())
    vi.advanceTimersByTime(1000)
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("fitted")
    // scale = min(960/960, 800/540) = 1; height 540, so 130px top and bottom.
    expect(document.querySelector<HTMLElement>(".slide")!.style.transform).toBe("translate(0px, 130px) scale(1)")
    expect(document.documentElement.style.width).toBe("")
  })

  it("waits for an out-of-process frame's size instead of bailing on a 0x0 viewport", () => {
    // Chrome can run the script before the parent has sized the frame: everything measures 0x0.
    const viewport = { w: 0, h: 0 }
    stubLayout(viewport)
    mountSlide(`<div class="slide" data-w="0" data-h="0"></div>`)
    run(slideFitPrelude())
    run(slideFitScript())
    expect(document.documentElement.getAttribute("data-compass-fit")).toBeNull()
    viewport.w = 1920
    viewport.h = 1080
    const slide = document.querySelector<HTMLElement>(".slide")!
    slide.dataset.w = "960"
    slide.dataset.h = "540"
    window.dispatchEvent(new Event("resize"))
    vi.advanceTimersByTime(1000)
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("fitted")
    expect(slide.style.transform).toBe("translate(0px, 0px) scale(2)")
  })

  it("gives up with a diagnostic if the frame never gets a size", () => {
    stubLayout({ w: 0, h: 0 })
    mountSlide(`<div class="slide" data-w="960" data-h="540"></div>`)
    run(slideFitPrelude())
    run(slideFitScript())
    vi.advanceTimersByTime(2100)
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("zero-viewport")
    expect(document.documentElement.style.visibility).toBe("")
  })

  it("does not fit a canvas below the minimum or a tall scrolling page", () => {
    stubLayout({ w: 1600, h: 900 })
    mountSlide(`<div data-w="300" data-h="200"></div>`)
    run(slideFitScript())
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("below-min-canvas")
    mountSlide(`<div data-w="800" data-h="4000"></div>`)
    run(slideFitScript())
    expect(document.documentElement.getAttribute("data-compass-fit")).toBe("too-tall")
  })

  it("announces when the fit has settled, so pins can be re-measured", () => {
    stubLayout({ w: 1920, h: 1080 })
    mountSlide(`<div class="slide" data-w="1280" data-h="720"></div>`)
    const settled = vi.fn()
    window.addEventListener(SLIDE_FIT_SETTLED_EVENT, settled)
    run(slideFitPrelude())
    run(slideFitScript())
    vi.advanceTimersByTime(2000)
    window.removeEventListener(SLIDE_FIT_SETTLED_EVENT, settled)
    expect(settled).toHaveBeenCalled()
    expect(document.documentElement.style.visibility).toBe("")
  })
})

describe("withSlideFit", () => {
  it("puts the prelude first and the fit script before the last </body>", () => {
    const out = withSlideFit("<!doctype html><html><head><link rel=stylesheet href=x></head><body><div></div></body></html>")
    expect(out.startsWith(slideFitPrelude())).toBe(true)
    expect(out).toContain(`${slideFitScript()}</body></html>`)
  })

  it("appends the fit script to a fragment with no body", () => {
    expect(withSlideFit("<div></div>").endsWith(slideFitScript())).toBe(true)
  })

  it("is applied to each slide of a SLIDE_DECK, not to a DOCUMENT", () => {
    const deck = `<!doctype html><html><body><section class="slide"><h1>One</h1></section><section class="slide"><h1>Two</h1></section></body></html>`
    const presentation = buildArtifactPresentation(deck, "SLIDE_DECK")
    expect(presentation.slides).toHaveLength(2)
    for (const slide of presentation.slides!) expect(slide.html).toContain("__compassSlideReveal")
    expect(buildArtifactPresentation(deck, null).html).not.toContain("__compassSlideReveal")
  })
})
