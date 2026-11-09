// @vitest-environment jsdom

import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactHero } from "@/components/gallery/artifact-hero"
import type { GalleryArtifact } from "@/lib/gallery/artifacts"

afterEach(cleanup)

const thumb = (id: string) => ({ src: `/api/artifacts/${id}/thumb`, width: 800, height: 500, capturedAt: "2026-01-01T00:00:00.000Z" })
const art = (id: string, over: Partial<GalleryArtifact> = {}): GalleryArtifact => ({
  id, title: id, sourceType: "HTML_UPLOAD", kind: "DOCUMENT", thumbnail: null, capturable: true, ...over,
})
const base = {
  isPrivate: false,
  moreArtifacts: 0,
  emptyTitle: "Nothing linked yet",
  emptyHint: "Open it to link something.",
  artifactHref: (id: string) => `/org/ws/docs/artifacts/${id}`,
  onCapture: vi.fn(async () => ({ ok: true as const })),
}
const hero = (artifacts: GalleryArtifact[], over: Record<string, unknown> = {}) => render(createElement(ArtifactHero, { ...base, artifacts, ...over }))

describe("ArtifactHero", () => {
  it("renders the caller's empty-state copy when no artifact is linked", () => {
    hero([])
    expect(screen.getByTestId("gallery-hero-empty")).toBeInTheDocument()
    expect(screen.getByText("Nothing linked yet")).toBeInTheDocument()
    expect(screen.getByText("Open it to link something.")).toBeInTheDocument()
  })

  it("opens on the first artifact that has a screenshot, not the first artifact", () => {
    hero([art("a1"), art("a2", { thumbnail: thumb("a2") })])
    expect(screen.getByRole("img", { name: "Preview of a2" })).toHaveAttribute("src", "/api/artifacts/a2/thumb")
  })

  it("shows a filmstrip of three with a +N count for the rest, including capped extras", () => {
    hero([art("a1"), art("a2"), art("a3"), art("a4")], { moreArtifacts: 2 })
    expect(screen.getAllByRole("button", { name: /^Show / })).toHaveLength(3)
    expect(screen.getByText("+3")).toBeInTheDocument()
  })

  it("swaps the hero when a filmstrip thumbnail is hovered", () => {
    hero([art("a1", { thumbnail: thumb("a1") }), art("a2", { thumbnail: thumb("a2") })])
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Show a2" }))
    expect(screen.getByRole("img", { name: "Preview of a2" })).toBeInTheDocument()
  })

  it("offers Capture preview for a capturable artifact without a screenshot, via the injected action", async () => {
    const onCapture = vi.fn(async () => ({ ok: false as const, error: "Page returned HTTP 404" }))
    hero([art("a1")], { onCapture })
    fireEvent.click(screen.getByRole("button", { name: "Capture preview" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Page returned HTTP 404"))
    expect(onCapture).toHaveBeenCalledWith("a1")
  })

  it("links to the artifact instead when it cannot be captured", () => {
    hero([art("a1", { capturable: false, sourceType: "V0_CHAT" })])
    expect(screen.queryByRole("button", { name: "Capture preview" })).toBeNull()
    expect(screen.getByRole("link", { name: "Open artifact" })).toHaveAttribute("href", "/org/ws/docs/artifacts/a1")
  })

  it("shows the Private badge", () => {
    hero([art("a1", { thumbnail: thumb("a1") })], { isPrivate: true })
    expect(screen.getByText("Private")).toBeInTheDocument()
  })
})
