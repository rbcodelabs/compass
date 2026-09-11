// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it } from "vitest"
import { DocDecisionAction } from "@/components/docs/doc-decision-action"

const props = { orgSlug: "org", workspaceSlug: "space", docId: "doc", docTitle: "Launch plan" }
afterEach(cleanup)
describe("Docs decision toolbar", () => {
  it("retains the document-prefilled request link when empty", () => {
    render(<DocDecisionAction {...props} decisions={[]} />)
    expect(screen.getByRole("link", { name: "Request decision" })).toHaveAttribute("href", "/org/space/decisions/new?subjectType=DOC&subjectId=doc&subjectTitle=Launch+plan")
  })
  it("links a single pending request with a count", () => {
    render(<DocDecisionAction {...props} decisions={[{ id: "request", title: "Ship?" }]} />)
    expect(screen.getByRole("link", { name: "Decision pending, 1 request" })).toHaveAttribute("href", "/org/space/reviews/request")
    expect(screen.getByText("1")).toBeVisible()
  })
  it("offers all requests in a keyboard-operated menu", async () => {
    render(<DocDecisionAction {...props} decisions={[{ id: "new", title: "Newest?" }, { id: "old", title: "Older?" }]} />)
    const button = screen.getByRole("button", { name: "Decisions pending, 2 requests" })
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
})
