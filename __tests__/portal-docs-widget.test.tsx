// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DocsForm, DocsRenderer } from "@/components/portal-home/widgets/docs"
import { stripLeadingTitle } from "@/lib/portal-docs/format"
import { docsDefinition } from "@/lib/portal-home/widgets/docs"

const config = docsDefinition.defaultConfig()
const doc = (n: number, over = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Guide ${n}`, excerpt: `Excerpt ${n}`,
  updatedAt: "2026-11-05T10:00:00.000Z", publishedAt: "2026-11-04T10:00:00.000Z", href: `/portal/acme/main/docs/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, ...over,
})

describe("Docs widget renderer", () => {
  it("renders cards with title, excerpt, updated date and links, plus a browse link", () => {
    const html = renderToStaticMarkup(<DocsRenderer config={config} data={{ type: "docs", docs: [doc(1), doc(2)] }} />)
    expect(html).toContain("Guide 1")
    expect(html).toContain("Excerpt 2")
    expect(html).toContain("Updated Nov 5, 2026")
    expect(html).toContain('href="/portal/acme/main/docs/00000000-0000-4000-8000-000000000001"')
    expect(html).toContain('href="/portal/acme/main/docs"')
    expect(html).toContain("@xl:grid-cols-2") // widens to a card grid with the widget, not the viewport
  })

  it("shows a friendly empty state", () => {
    const html = renderToStaticMarkup(<DocsRenderer config={config} data={{ type: "docs", docs: [] }} />)
    expect(html).toContain("No docs published yet")
    expect(html).not.toContain("Browse all docs")
  })
})

describe("Docs widget form", () => {
  const options = { roadmapItems: [], docs: [{ id: doc(1).id, title: "Guide 1", isPublished: true }, { id: doc(2).id, title: "Draft two", isPublished: false }] }

  it("hides the picker in all mode and offers publishable docs with their state in selected mode", () => {
    const { rerender } = render(<DocsForm config={config} options={options} onChange={() => {}} />)
    expect(screen.queryByLabelText("Publishable docs")).toBeNull()
    rerender(<DocsForm config={{ ...config, mode: "selected" }} options={options} onChange={() => {}} />)
    expect(screen.getByText("Guide 1")).toBeTruthy()
    expect(screen.getByText("Published")).toBeTruthy()
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0)
    cleanup()
  })

  it("picking a doc appends its id in order", () => {
    const onChange = vi.fn()
    render(<DocsForm config={{ ...config, mode: "selected", docIds: [doc(2).id] }} options={options} onChange={onChange} />)
    fireEvent.click(screen.getByRole("checkbox", { name: /Guide 1/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ docIds: [doc(2).id, doc(1).id] }))
    cleanup()
  })
})

describe("stripLeadingTitle", () => {
  it("drops a first H1 that repeats the title, and nothing else", () => {
    expect(stripLeadingTitle("# My Doc\n\nBody", "my doc")).toBe("Body")
    expect(stripLeadingTitle("# Other\n\nBody", "My Doc")).toBe("# Other\n\nBody")
    expect(stripLeadingTitle("Intro\n\n# My Doc", "My Doc")).toBe("Intro\n\n# My Doc")
    expect(stripLeadingTitle("## My Doc\nBody", "My Doc")).toBe("## My Doc\nBody")
  })
})
