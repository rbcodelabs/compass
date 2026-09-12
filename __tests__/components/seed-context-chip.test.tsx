// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SeedContextChip } from "@/components/agent/seed-context-chip"

afterEach(cleanup)

describe("SeedContextChip", () => {
  it("renders the label, summary, and a link back to the source", () => {
    render(
      <SeedContextChip
        label="Approved plan · Redesigned onboarding"
        summary="Ship a redesigned onboarding flow in two phases."
        sourceUrl="/acme/product/discovery/opp-1?detail=solution:sol-1"
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByText("Approved plan · Redesigned onboarding")).toBeInTheDocument()
    expect(screen.getByText("Ship a redesigned onboarding flow in two phases.")).toBeInTheDocument()
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "/acme/product/discovery/opp-1?detail=solution:sol-1")
  })

  it("calls onDismiss when the dismiss button is clicked", () => {
    const onDismiss = vi.fn()
    render(
      <SeedContextChip
        label="Approved plan · Redesigned onboarding"
        summary="Ship a redesigned onboarding flow."
        sourceUrl="/acme/product/discovery/opp-1"
        onDismiss={onDismiss}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
