// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { RoadmapHeader } from "@/components/roadmap/roadmap-header"

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams(), set: vi.fn() }),
}))


describe("RoadmapHeader card sort entry", () => {
  afterEach(cleanup)

  it("links to a card sort round over Roadmap Items from the more-actions menu", async () => {
    render(<RoadmapHeader squads={[]} cardSortHref="/acme/core/card-sort?objectType=ROADMAP_ITEM" />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    expect(await screen.findByRole("menuitem", { name: /card sort/i })).toHaveAttribute(
      "href",
      "/acme/core/card-sort?objectType=ROADMAP_ITEM"
    )
  })

  it("has no more-actions menu when there is no href and no timeline", () => {
    render(<RoadmapHeader squads={[]} />)
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull()
  })
})
