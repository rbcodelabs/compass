// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { auth, findFirst, ensureBuildingInvestmentRevisionFresh } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirst: vi.fn(),
  ensureBuildingInvestmentRevisionFresh: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ reviewRequest: { findFirst } }) }))
vi.mock("@/lib/building-investment", () => ({
  ensureBuildingInvestmentRevisionFresh,
  ensureBuildingInvestmentRevocationRevisionFresh: vi.fn(),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({ decideReviewAction: vi.fn() }))
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

import ReviewRequestPage from "@/app/[orgSlug]/[workspaceSlug]/reviews/[requestId]/page"

function reviewRequest(gateType: "BUILDING_INVESTMENT" | "TRACKED_DECISION") {
  return {
    id: "request-1",
    workspaceId: "workspace-1",
    subjectId: "solution-1",
    subjectType: "SOLUTION",
    gateType,
    currentRevision: {
      id: "revision-1",
      title: "Should we build this?",
      summary: "Review the evidence.",
      fingerprint: "fingerprint-1",
      supersededAt: null,
      packetJson: JSON.stringify({
        schemaVersion: "tracked-decision/v2",
        question: "Should we build this?",
        context: "Review the evidence.",
        entity: { type: "SOLUTION", id: "solution-1", title: "A solution" },
        sources: [],
        solution: { title: "A solution", status: "VALIDATING", opportunityTitle: "An opportunity" },
      }),
      options: [],
      decisions: [],
    },
    revisions: [],
    workspace: {
      members: [{ id: "member-1", role: "ADMIN" }],
      organization: { members: [] },
    },
  }
}

describe("review request page eyebrow", () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    ensureBuildingInvestmentRevisionFresh.mockResolvedValue({ stale: false })
  })

  it("preserves the Building investment review label", async () => {
    findFirst.mockResolvedValue(reviewRequest("BUILDING_INVESTMENT"))

    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))

    expect(screen.getByText("Building investment review")).toBeDefined()
  })

  it("uses the tracked decision label for tracked decisions", async () => {
    findFirst.mockResolvedValue(reviewRequest("TRACKED_DECISION"))

    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))

    expect(screen.getByText("Decision")).toBeDefined()
    expect(screen.queryByText(/Legacy system decision/)).toBeNull()
  })
})
