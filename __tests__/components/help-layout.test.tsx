// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/docs", () => ({
  getAllDocs: () => [
    { slug: "00-overview", title: "Overview", section: "Basics" },
  ],
  getDoc: async () => ({ title: "Overview", description: "Compass overview" }),
}))

vi.mock("@/components/help-nav-link", () => ({
  NavLink: ({ href, label }: { href: string; label: string }) => <a href={href}>{label}</a>,
}))

import HelpLayout, { metadata } from "@/app/help/layout"
import { generateMetadata } from "@/app/help/[slug]/page"

describe("User Guide layout", () => {
  it("uses User Guide in the page header and accessible navigation label", () => {
    render(<HelpLayout><p>Guide content</p></HelpLayout>)

    expect(screen.getByRole("link", { name: "Compass/User Guide" })).toHaveAttribute("href", "/help")
    expect(screen.getByRole("navigation", { name: "User Guide navigation" })).toBeInTheDocument()
  })

  it("publishes User Guide page metadata", () => {
    expect(metadata).toEqual({ title: "User Guide" })
  })

  it("identifies guide articles as User Guide pages in metadata", async () => {
    await expect(generateMetadata({ params: Promise.resolve({ slug: "00-overview" }) })).resolves.toEqual({
      title: "Overview — Compass User Guide",
      description: "Compass overview",
    })
  })
})
