// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LinkedOpportunitiesSection } from "@/components/panels/linked-opportunities-section"
import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import type { LinkedOpportunities, LinkedOpportunityRow } from "@/lib/objective-linked-opportunities"

vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn() }) }))

afterEach(cleanup)

const row = (n: number, extra: Partial<LinkedOpportunityRow> = {}): LinkedOpportunityRow => ({
  id: `opp-${n}`,
  title: `Opportunity ${n}`,
  status: "EXPLORING",
  direct: true,
  viaKeyResults: [],
  rawScore: 5000 - n,
  normalizedScore: 1,
  scoreStale: false,
  ...extra,
})

const view = (data: LinkedOpportunities, source = {}) =>
  render(
    <ThinkingModelProvider value={resolveThinkingModel(source)}>
      <LinkedOpportunitiesSection data={data} orgSlug="acme" workspaceSlug="alpha" />
    </ThinkingModelProvider>,
  )

describe("LinkedOpportunitiesSection", () => {
  it("shows a short empty state", () => {
    view({ scoringActive: true, items: [] })
    expect(screen.getByText("No opportunities linked.")).toBeInTheDocument()
    expect(screen.queryByRole("table")).toBeNull()
  })

  it("renders title link, status badge and the RAW score as the headline", () => {
    view({ scoringActive: true, items: [row(1, { status: "VALIDATING", rawScore: 4000, normalizedScore: 80 })] })
    const link = screen.getByRole("link", { name: "Opportunity 1" })
    expect(link).toHaveAttribute("href", "/acme/alpha/discovery/opp-1")
    expect(screen.getByText("Validating")).toBeInTheDocument()
    const score = screen.getByTestId("linked-opportunity-score")
    expect(score).toHaveTextContent("4,000")
    expect(score).not.toHaveTextContent("80")
    expect(score).toHaveAttribute("title", "Normalized 80 / 100")
  })

  it("shows direct / via key result indicators and unscored rows", () => {
    view({
      scoringActive: true,
      items: [
        row(1, { direct: false, viaKeyResults: [{ id: "kr1", title: "Grow signups" }] }),
        row(2, { rawScore: null, normalizedScore: null }),
      ],
    })
    const vias = screen.getAllByTestId("linked-opportunity-via")
    expect(vias[0]).toHaveTextContent("via Key Result: Grow signups")
    expect(vias[1]).toHaveTextContent("Direct")
    expect(screen.getByText("Not scored")).toBeInTheDocument()
  })

  it("hides the score column entirely when no scoring model is active", () => {
    view({ scoringActive: false, items: [row(1, { rawScore: undefined, normalizedScore: undefined, scoreStale: undefined })] })
    expect(screen.queryByRole("columnheader", { name: "Score" })).toBeNull()
    expect(screen.queryByTestId("linked-opportunity-score")).toBeNull()
    expect(screen.getAllByRole("columnheader")).toHaveLength(2)
  })

  it("renders 20 rows inside a bounded, scrollable container with a minimum table width", () => {
    const items = Array.from({ length: 20 }, (_, i) => row(i + 1))
    const { container } = view({ scoringActive: true, items })
    expect(screen.getAllByTestId("linked-opportunity-row")).toHaveLength(20)
    expect(screen.getByText(/\(20\)/)).toBeInTheDocument()
    const scroller = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(scroller.className).toMatch(/max-h-/)
    expect(scroller.className).toMatch(/overflow-auto/)
    expect(within(scroller).getByRole("table").className).toMatch(/min-w-\[/)
  })

  it("uses renamed thinking-model labels", () => {
    view(
      { scoringActive: true, items: [] },
      { thinkingModelLabels: JSON.stringify({ opportunity: { singular: "Bet", plural: "Bets" } }) },
    )
    expect(screen.getByText("Linked Bets")).toBeInTheDocument()
    expect(screen.getByText("No bets linked.")).toBeInTheDocument()
  })
})
