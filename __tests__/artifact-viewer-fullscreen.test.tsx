// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactViewer } from "@/components/docs/artifact-viewer"

const slides = [
  { index: 0, title: "Intro", description: null, html: "<html><body>one</body></html>" },
  { index: 1, title: "Pricing", description: null, html: "<html><body>two</body></html>" },
  { index: 2, title: null, description: null, html: "<html><body>three</body></html>" },
]

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ArtifactViewer full-screen deck", () => {
  it("floats one controller pill over the preview instead of toolbar rows", () => {
    render(<ArtifactViewer title="Deck" artifactId="a1" slides={slides} backHref="/docs/artifacts/a1" fill />)
    const controls = screen.getByRole("navigation", { name: "Artifact controls" })
    expect(controls).toHaveTextContent("1 / 3")
    expect(screen.getByRole("link", { name: "Back to artifact" })).toHaveAttribute("href", "/docs/artifacts/a1?slide=1")
    // The docked toolbar's separate slide nav row is gone.
    expect(screen.queryByRole("navigation", { name: "Slides" })).toBeNull()
  })

  it("steps slides with Next/Prev and disables the ends", () => {
    render(<ArtifactViewer title="Deck" artifactId="a1" slides={slides} fill />)
    expect(screen.getByRole("button", { name: "Previous slide" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }))
    expect(screen.getByRole("navigation", { name: "Artifact controls" })).toHaveTextContent("2 / 3")
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }))
    expect(screen.getByRole("button", { name: "Next slide" })).toBeDisabled()
  })

  it("jumps via the All slides picker and closes on Escape", () => {
    render(<ArtifactViewer title="Deck" artifactId="a1" slides={slides} fill />)
    fireEvent.click(screen.getByRole("button", { name: "All slides" }))
    const dialog = screen.getByRole("dialog", { name: "Go to slide" })
    expect(dialog).toHaveTextContent("Pricing")
    fireEvent.click(screen.getByRole("button", { name: "Slide 2: Pricing" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByRole("navigation", { name: "Artifact controls" })).toHaveTextContent("2 / 3")

    fireEvent.click(screen.getByRole("button", { name: "All slides" }))
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("opens a floating whole-slide comment form", () => {
    render(<ArtifactViewer title="Deck" artifactId="a1" slides={slides} fill />)
    fireEvent.click(screen.getByRole("button", { name: "Comment on slide" }))
    expect(screen.getByRole("textbox", { name: "Anchored feedback" })).toBeInTheDocument()
    expect(screen.getByText(/Commenting on slide 1 · Intro/)).toBeInTheDocument()
  })

  it("keeps the docked toolbar when not in fill mode", () => {
    render(<ArtifactViewer title="Deck" artifactId="a1" slides={slides} fullScreenHref="/full" />)
    expect(screen.getByRole("navigation", { name: "Slides" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /View full screen/ })).toHaveAttribute("href", "/full?slide=1")
    expect(screen.queryByRole("navigation", { name: "Artifact controls" })).toBeNull()
  })
})
