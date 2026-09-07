// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({ decideReviewAction: vi.fn(), createTrackedDecisionAction: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { DecisionActions } from "@/components/decisions/decision-actions"
import { RequestDecisionLink } from "@/components/decisions/request-decision-link"

describe("simple decision UI", () => {
  it("shows a rationale field alongside all three outcomes", () => {
    render(<DecisionActions workspaceId="ws-1" revisionId="rev-1" fingerprint="fp" options={[
      { id: "a", label: "Approve", outcomeClass: "APPROVE" },
      { id: "c", label: "Request changes", outcomeClass: "REQUEST_CHANGES" },
      { id: "r", label: "Reject", outcomeClass: "REJECT" },
    ]} />)
    expect(screen.getByLabelText(/rationale/i)).toBeDefined()
    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
  })

  it("builds a prefilled entity request link", () => {
    render(<RequestDecisionLink orgSlug="acme" workspaceSlug="product" subjectType="SOLUTION" subjectId="solution-1" subjectTitle="Simple decisions" />)
    expect(screen.getByRole("link", { name: /request decision/i }).getAttribute("href")).toContain("subjectType=SOLUTION")
  })
})
