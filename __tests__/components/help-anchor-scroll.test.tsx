// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let pathname = "/help/04-roadmap"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))

import { HelpAnchorScroll } from "@/components/help-anchor-scroll"

describe("HelpAnchorScroll", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pathname = "/help/04-roadmap"
    document.body.innerHTML = ""
    window.location.hash = ""
    scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
  })

  afterEach(() => {
    cleanup()
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  })

  it("scrolls the hash target into view on mount when a hash is present", () => {
    const target = document.createElement("div")
    target.id = "not-yet-on-the-roadmap"
    document.body.appendChild(target)
    window.location.hash = "#not-yet-on-the-roadmap"

    render(<HelpAnchorScroll />)

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" })
  })

  it("does nothing when there is no hash", () => {
    render(<HelpAnchorScroll />)

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it("does nothing when the hash matches no element in the document", () => {
    window.location.hash = "#missing-section"

    render(<HelpAnchorScroll />)

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it("re-scrolls after a client-side route change lands on a different doc with a different hash", () => {
    // Reproduces the bug found in QA: navigating from the ⌘K palette's Help
    // results does a client-side transition to a new /help/<slug>#<anchor>
    // route rather than a fresh page load, so the effect must re-run and
    // scroll again when `pathname` changes, not just once on first mount.
    const first = document.createElement("div")
    first.id = "section-a"
    document.body.appendChild(first)
    window.location.hash = "#section-a"

    const { rerender } = render(<HelpAnchorScroll />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    const second = document.createElement("div")
    second.id = "section-b"
    document.body.appendChild(second)
    window.location.hash = "#section-b"
    pathname = "/help/01-okrs"

    rerender(<HelpAnchorScroll />)

    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" })
  })

  it("re-scrolls once a still-loading doc image finishes and shifts layout", () => {
    const target = document.createElement("div")
    target.id = "not-yet-on-the-roadmap"
    document.body.appendChild(target)
    window.location.hash = "#not-yet-on-the-roadmap"

    const wrapper = document.createElement("div")
    wrapper.className = "docs-content"
    const img = document.createElement("img")
    Object.defineProperty(img, "complete", { value: false, configurable: true })
    wrapper.appendChild(img)
    document.body.appendChild(wrapper)

    render(<HelpAnchorScroll />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    img.dispatchEvent(new Event("load"))

    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })
})
