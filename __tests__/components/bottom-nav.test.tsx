// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/product/feedback" }))

import { BottomNav } from "@/components/bottom-nav"

describe("BottomNav research rollout", () => {
  afterEach(cleanup)

  it("keeps the legacy Feedback destination while research capture is gated off", () => {
    render(<BottomNav orgSlug="acme" workspaceSlug="product" researchCaptureEnabled={false} />)

    expect(screen.getByRole("link", { name: "Feedback" })).toHaveAttribute("href", "/acme/product/feedback")
    expect(screen.queryByRole("link", { name: "Capture" })).not.toBeInTheDocument()
  })

  it("shows Capture only after the rollout gate is enabled", () => {
    render(<BottomNav orgSlug="acme" workspaceSlug="product" researchCaptureEnabled />)

    expect(screen.getByRole("link", { name: "Capture" })).toHaveAttribute("href", "/acme/product/capture")
    expect(screen.queryByRole("link", { name: "Feedback" })).not.toBeInTheDocument()
  })
})
