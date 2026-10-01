// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { RoadmapHeader } from "@/components/roadmap/roadmap-header"

vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams(), set: vi.fn() }),
}))


describe("RoadmapHeader card sort entry", () => {
  afterEach(cleanup)

  it("links to a card sort round over Roadmap Items", () => {
    render(<RoadmapHeader squads={[]} cardSortHref="/acme/core/card-sort?objectType=ROADMAP_ITEM" />)
    expect(screen.getByRole("link", { name: /card sort/i })).toHaveAttribute(
      "href",
      "/acme/core/card-sort?objectType=ROADMAP_ITEM"
    )
  })

  it("omits the link when no href is given", () => {
    render(<RoadmapHeader squads={[]} />)
    expect(screen.queryByRole("link", { name: /card sort/i })).toBeNull()
  })
})
