// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { describe, expect, it } from "vitest"
import { DecisionSources, parseTrackedDecisionPacket } from "@/components/decisions/decision-sources"

const updatedAt = "2026-09-04T12:00:00.000Z"

describe("Decision sources", () => {
  it("renders titled navigable snapshots without exposing UUIDs", () => {
    render(<DecisionSources orgSlug="acme" workspaceSlug="product" entity={{ type: "EXPERIMENT", id: "11111111-1111-4111-8111-111111111111", title: "Five-second brand test", updatedAt }} sources={[
      { type: "ASSUMPTION", id: "22222222-2222-4222-8222-222222222222", title: "Visitors recognize the product", updatedAt },
      { type: "DOC", id: "33333333-3333-4333-8333-333333333333", title: "Test script", updatedAt },
      { type: "EVIDENCE", id: "44444444-4444-4444-8444-444444444444", title: "Interview excerpt", updatedAt },
    ]} />)

    expect(screen.getByRole("link", { name: /Five-second brand test/ })).toHaveAttribute("href", expect.stringContaining("detail=experiment%3A11111111"))
    expect(screen.getByRole("link", { name: /Visitors recognize the product/ })).toHaveAttribute("href", expect.stringContaining("detail=assumption%3A22222222"))
    expect(screen.getByRole("link", { name: /Test script/ })).toHaveAttribute("href", "/acme/product/docs/33333333-3333-4333-8333-333333333333")
    expect(screen.getByText("Interview excerpt")).toBeInTheDocument()
    expect(screen.queryByText(/44444444/)).toBeNull()
    expect(screen.getAllByText("Captured Sep 4, 2026").length).toBeGreaterThan(0)
  })

  it("safely parses v1 and rejects malformed packets", () => {
    expect(parseTrackedDecisionPacket(JSON.stringify({ schemaVersion: "tracked-decision/v1", question: "Old", context: "Legacy", entity: { type: "DOC", id: "doc-1", title: "Old doc" } }))).toEqual(expect.objectContaining({ sources: [] }))
    expect(parseTrackedDecisionPacket("not-json")).toBeNull()
    expect(parseTrackedDecisionPacket(JSON.stringify({ schemaVersion: "tracked-decision/v2", context: "Missing entity" }))).toBeNull()
  })

  it("wraps long titles and identifies non-navigable snapshots", () => {
    const longTitle = "A very long evidence title that must remain entirely visible even when it contains anunbrokenidentifierthatneedstowrap"
    const view = render(<DecisionSources orgSlug="acme" workspaceSlug="product" entity={{ type: "EXPERIMENT", id: "experiment-1", title: "Test", updatedAt }} sources={[
      { type: "EVIDENCE", id: "evidence-1", title: longTitle, updatedAt },
    ]} />)

    expect(view.getByText(longTitle)).toHaveClass("break-words", "whitespace-normal")
    expect(view.getByText(longTitle)).toHaveClass("[overflow-wrap:anywhere]")
    const row = view.getByText(longTitle).closest("li")?.firstElementChild
    expect(row).toHaveClass("flex-col", "items-start", "sm:flex-row", "sm:items-center")
    expect(view.getAllByText("Snapshot only").length).toBeGreaterThan(0)
    expect(view.queryByRole("link", { name: new RegExp(longTitle) })).toBeNull()
  })
})
