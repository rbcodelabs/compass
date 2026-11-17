// @vitest-environment jsdom
/**
 * The embedded Decision card with advisory votes (ADR-0030): the options and counts, who may vote, retracting, the anonymity-until-decided
 * wording, and that a viewer who may not vote gets a plain result.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SpecEmbedCard } from "@/components/docs/spec-embed-card"
import type { EmbedEntry } from "@/components/docs/doc-embed-cards"
import type { DecisionTally } from "@/lib/decision-votes"
import type { DocEmbedCardView } from "@/lib/canvas-card-data"

afterEach(cleanup)

const ID = "0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b"
const tallyOf = (extra: Partial<DecisionTally> = {}, myVote: string | null = null): DecisionTally => ({
  state: "PENDING",
  open: true,
  questions: [{ question: "Advisory or binding?", myVote, options: [{ label: "Advisory", count: 3 }, { label: "Binding", count: 1 }] }],
  ...extra,
})
const entry = (tally: DecisionTally, status = "PENDING"): EmbedEntry => ({
  status: "ready",
  card: { state: "ok", kind: "decision", id: ID, title: "How should votes work?", status, facts: [], href: "/acme/alpha/reviews/" + ID, tally } as DocEmbedCardView,
})

describe("Decision card voting", () => {
  it("shows each option with its count", () => {
    render(<SpecEmbedCard kind="decision" entry={entry(tallyOf())} defaultExpanded vote={vi.fn()} />)
    const options = screen.getAllByTestId("decision-option")
    expect(options).toHaveLength(2)
    expect(within(options[0]).getByText("Advisory")).toBeInTheDocument()
    expect(within(options[0]).getByText("3")).toBeInTheDocument()
    expect(screen.getByText(/anonymous until the decision is recorded/i)).toBeInTheDocument()
  })

  it("casts a vote for the clicked option", async () => {
    const vote = vi.fn().mockResolvedValue(null)
    render(<SpecEmbedCard kind="decision" entry={entry(tallyOf())} defaultExpanded vote={vote} />)
    fireEvent.click(screen.getAllByTestId("decision-option")[1])
    await waitFor(() => expect(vote).toHaveBeenCalledWith(0, "Binding"))
  })

  it("clicking the option you already chose retracts the vote", async () => {
    const vote = vi.fn().mockResolvedValue(null)
    render(<SpecEmbedCard kind="decision" entry={entry(tallyOf({}, "Advisory"))} defaultExpanded vote={vote} />)
    const mine = screen.getAllByTestId("decision-option")[0]
    expect(mine).toHaveAttribute("aria-pressed", "true")
    expect(mine).toHaveTextContent("(your vote)")
    fireEvent.click(mine)
    await waitFor(() => expect(vote).toHaveBeenCalledWith(0, null))
  })

  it("shows a refusal from the server instead of failing silently", async () => {
    const vote = vi.fn().mockResolvedValue("Voting is closed for this decision.")
    render(<SpecEmbedCard kind="decision" entry={entry(tallyOf())} defaultExpanded vote={vote} />)
    fireEvent.click(screen.getAllByTestId("decision-option")[0])
    expect(await screen.findByTestId("decision-vote-error")).toHaveTextContent("Voting is closed")
  })

  it("is a plain result for a viewer who cannot vote", () => {
    render(<SpecEmbedCard kind="decision" entry={entry(tallyOf())} defaultExpanded vote={null} />)
    for (const option of screen.getAllByTestId("decision-option")) expect(option).toBeDisabled()
    expect(screen.getByText(/only workspace members can vote/i)).toBeInTheDocument()
  })

  it("is closed and names the voters once the decision is recorded", () => {
    const decided = tallyOf({ state: "DECIDED", open: false })
    decided.questions[0].options[0].voters = ["Ada", "Grace", "Member"]
    decided.questions[0].options[1].voters = ["Alan"]
    render(<SpecEmbedCard kind="decision" entry={entry(decided, "DECIDED")} defaultExpanded vote={vi.fn()} />)
    for (const option of screen.getAllByTestId("decision-option")) expect(option).toBeDisabled()
    expect(screen.getByText("Ada, Grace, Member")).toBeInTheDocument()
    expect(screen.getByText(/decided\. votes were advisory/i)).toBeInTheDocument()
  })

  it("does not render a tally for a card without one", () => {
    const plain: EmbedEntry = { status: "ready", card: { state: "ok", kind: "decision", id: ID, title: "No choices", status: "PENDING", facts: [], href: "/acme/alpha/reviews/" + ID } }
    render(<SpecEmbedCard kind="decision" entry={plain} defaultExpanded />)
    expect(screen.queryByTestId("decision-tally")).toBeNull()
  })
})
