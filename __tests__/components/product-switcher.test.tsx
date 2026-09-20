// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { ProductSwitcher } from "@/components/marketing/product-switcher"

afterEach(cleanup)

describe("ProductSwitcher", () => {
  it("wraps the segments in a nav landmark labeled Product family", () => {
    render(<ProductSwitcher />)
    expect(screen.getByRole("navigation", { name: "Product family" })).toBeInTheDocument()
  })

  it("marks Compass as the current, non-link segment", () => {
    render(<ProductSwitcher />)
    // "Compass" appears as inline text inside the aria-current segment; find
    // the segment itself via its explicit aria-label, since the visible text
    // label collapses to `hidden` below the `sm` breakpoint.
    expect(screen.getByLabelText("Compass")).toHaveAttribute("aria-current", "page")
    expect(screen.queryByRole("link", { name: /Compass/ })).not.toBeInTheDocument()
  })

  it("links Geode and Threads to their live subdomains", () => {
    render(<ProductSwitcher />)
    expect(screen.getByRole("link", { name: "Geode" })).toHaveAttribute("href", "https://geode.rbcodelabs.com")
    expect(screen.getByRole("link", { name: "Threads" })).toHaveAttribute("href", "https://threads.rbcodelabs.com")
  })
})
