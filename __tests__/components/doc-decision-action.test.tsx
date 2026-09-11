// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it } from "vitest"
import { DocDecisionAction } from "@/components/docs/doc-decision-action"
import type { DecidedDocDecision } from "@/lib/tracked-decisions"

const props = { orgSlug: "org", workspaceSlug: "space", docId: "doc", docTitle: "Launch plan" }
const state = (pending: { id: string; title: string }[] = [], latestDecided: DecidedDocDecision | null = null) => ({ pending, latestDecided })
const decided = (overrides: Partial<DecidedDocDecision> = {}): DecidedDocDecision => ({
  id: "request", title: "Ship the launch plan?", outcome: "APPROVE", outcomeLabel: "Approve",
  decidedAt: new Date("2026-09-11T12:00:00.000Z"), reviewerName: "Ada Lovelace", ...overrides,
})

afterEach(cleanup)

describe("Docs decision toolbar", () => {
  it("retains the document-prefilled request link when there are no decisions at all", () => {
    render(<DocDecisionAction {...props} decisions={state()} />)
    expect(screen.getByRole("link", { name: "Request decision" })).toHaveAttribute("href", "/org/space/decisions/new?subjectType=DOC&subjectId=doc&subjectTitle=Launch+plan")
  })

  it("links a single pending request without a redundant count", () => {
    render(<DocDecisionAction {...props} decisions={state([{ id: "request", title: "Ship?" }])} />)
    expect(screen.getByRole("link", { name: "Decision pending, 1 request" })).toHaveAttribute("href", "/org/space/reviews/request")
    // The count is for disambiguating a list; at one request the singular
    // label already says it, and no list opens.
    expect(screen.queryByText("1")).not.toBeInTheDocument()
  })

  it("offers all requests in a keyboard-operated menu, with the count", async () => {
    render(<DocDecisionAction {...props} decisions={state([{ id: "new", title: "Newest?" }, { id: "old", title: "Older?" }])} />)
    const button = screen.getByRole("button", { name: "Decisions pending, 2 requests" })
    expect(screen.getByText("2")).toBeVisible()
    button.focus()
    fireEvent.keyDown(button, { key: "ArrowDown" })
    const items = await screen.findAllByRole("menuitem")
    expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["Newest?", "Older?"])
    expect(screen.getAllByText("Open decision")).toHaveLength(2)
    expect(items[0]).toHaveAttribute("href", "/org/space/reviews/new")
    expect(items[1]).toHaveAttribute("href", "/org/space/reviews/old")
    fireEvent.keyDown(items[0], { key: "Escape" })
    expect(button).toHaveAttribute("aria-expanded", "false")
  })

  it("shows unavailable status instead of a new request when lookup fails", () => {
    render(<DocDecisionAction {...props} decisions={null} />)
    expect(screen.getByRole("link", { name: "Decision status unavailable" })).toHaveAttribute("href", "/org/space/decisions")
    expect(screen.queryByText("Request decision")).not.toBeInTheDocument()
  })

  describe("once a decision has been recorded", () => {
    it("surfaces the outcome instead of falling back to the request zero state", () => {
      // The regression this guards: the pending list going empty on approval
      // used to reset the toolbar to "Request decision", hiding the decision
      // and inviting a duplicate request.
      render(<DocDecisionAction {...props} decisions={state([], decided())} />)
      expect(screen.getByRole("button", { name: /Approved by Ada Lovelace/ })).toBeVisible()
      expect(screen.queryByRole("link", { name: "Request decision" })).not.toBeInTheDocument()
    })

    it.each([
      ["APPROVE", "Approved"],
      ["REQUEST_CHANGES", "Changes requested"],
      ["REJECT", "Rejected"],
    ])("renders the %s outcome as %s", (outcome, expected) => {
      render(<DocDecisionAction {...props} decisions={state([], decided({ outcome }))} />)
      expect(screen.getByText(expected)).toBeVisible()
    })

    it("falls back to the option label for an unrecognized outcome class", () => {
      render(<DocDecisionAction {...props} decisions={state([], decided({ outcome: "DEFER", outcomeLabel: "Deferred" }))} />)
      expect(screen.getByText("Deferred")).toBeVisible()
    })

    it("opens the decision and offers a follow-up request", async () => {
      render(<DocDecisionAction {...props} decisions={state([], decided())} />)
      const button = screen.getByRole("button", { name: /Approved by Ada Lovelace/ })
      button.focus()
      fireEvent.keyDown(button, { key: "ArrowDown" })
      const items = await screen.findAllByRole("menuitem")
      expect(items[0]).toHaveAttribute("aria-label", "Ship the launch plan?")
      expect(items[0]).toHaveAttribute("href", "/org/space/reviews/request")
      expect(items[1]).toHaveAttribute("aria-label", "Request another decision")
      // Same prefilled subject contract as the zero-state link.
      expect(items[1]).toHaveAttribute("href", "/org/space/decisions/new?subjectType=DOC&subjectId=doc&subjectTitle=Launch+plan")
    })

    it("omits the reviewer when the actor cannot be resolved", () => {
      render(<DocDecisionAction {...props} decisions={state([], decided({ reviewerName: null }))} />)
      expect(screen.getByRole("button", { name: /^Approved · / })).toBeVisible()
    })

    it("gives a live pending request precedence over a settled one", () => {
      // An open question is actionable; a recorded outcome is history.
      render(<DocDecisionAction {...props} decisions={state([{ id: "open", title: "Reconsider?" }], decided())} />)
      expect(screen.getByRole("link", { name: "Decision pending, 1 request" })).toBeVisible()
      expect(screen.queryByText("Approved")).not.toBeInTheDocument()
    })
  })
})
