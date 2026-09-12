// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { auth, findFirst, findArtifacts, linkedArtifacts, ensureBuildingInvestmentRevisionFresh, findTaskLinks, eligibleAssignees } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirst: vi.fn(),
  findArtifacts: vi.fn(), linkedArtifacts: vi.fn(),
  ensureBuildingInvestmentRevisionFresh: vi.fn(),
  // Direction B: the decided branch now loads follow-through data.
  findTaskLinks: vi.fn(), eligibleAssignees: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ reviewRequest: { findFirst }, artifact: { findMany: findArtifacts }, taskLink: { findMany: findTaskLinks } }) }))
vi.mock("@/lib/artifacts", () => ({ getDecisionArtifacts: linkedArtifacts }))
vi.mock("@/lib/task-assignment", () => ({ eligibleTaskAssignees: eligibleAssignees }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ linkArtifactDecision: vi.fn(), unlinkArtifactDecision: vi.fn() }))
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
        entity: { type: "SOLUTION", id: "solution-1", title: "A solution", updatedAt: "2026-09-01T00:00:00Z" },
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
    findTaskLinks.mockResolvedValue([])
    eligibleAssignees.mockResolvedValue([])
    findArtifacts.mockResolvedValue([{ id: "new", title: "New prototype" }])
    linkedArtifacts.mockResolvedValue([{ id: "linked", title: "Existing prototype", status: "ACTIVE", currentRevision: { revisionNumber: 2 } }])
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

  it("places supporting Artifacts alongside the subject and offers only unlinked active choices", async () => {
    findFirst.mockResolvedValue(reviewRequest("TRACKED_DECISION"))
    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))
    expect(screen.getByRole("link", { name: "Existing prototype" })).toBeDefined()
    expect(screen.getByRole("combobox", { name: "Artifact to link" })).toBeDefined()
    expect(findArtifacts.mock.calls[0][0].where).toEqual({ workspaceId: "workspace-1", status: "ACTIVE", id: { notIn: ["linked"] } })
  })

  it("does not grant Artifact editing to org-admin-only Decision readers", async () => {
    const request = reviewRequest("TRACKED_DECISION")
    request.workspace.members = []
    request.workspace.organization.members = [{ role: "ADMIN" }] as never[]
    findFirst.mockResolvedValue(request)
    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))
    expect(screen.getByRole("link", { name: "Existing prototype" })).toBeDefined()
    expect(screen.queryByRole("combobox", { name: "Artifact to link" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Unlink Existing prototype" })).toBeNull()
    expect(findArtifacts).not.toHaveBeenCalled()
  })
})

describe("review request page — \"Send to agent\" on a decided banner", () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    ensureBuildingInvestmentRevisionFresh.mockResolvedValue({ stale: false })
    findTaskLinks.mockResolvedValue([])
    eligibleAssignees.mockResolvedValue([])
    findArtifacts.mockResolvedValue([])
    linkedArtifacts.mockResolvedValue([])
  })

  function decidedRequest(gateType: "TRACKED_DECISION" | "BUILDING_INVESTMENT", outcomeClass: "APPROVE" | "REJECT" | "REQUEST_CHANGES") {
    const request = reviewRequest(gateType)
    request.currentRevision.decisions = [
      { option: { label: outcomeClass === "APPROVE" ? "Approve" : outcomeClass === "REJECT" ? "Reject" : "Request changes", outcomeClass }, actorRole: "ADMIN", decidedAt: new Date("2026-09-01T00:00:00Z"), rationale: "Because." },
    ] as never[]
    return request
  }

  it("shows a Send to agent link for a decided TRACKED_DECISION with outcome APPROVE", async () => {
    findFirst.mockResolvedValue(decidedRequest("TRACKED_DECISION", "APPROVE"))
    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))
    const link = screen.getByRole("link", { name: /send to agent/i })
    expect(link.getAttribute("href")).toBe("/acme/product/agent?entityType=decision&entityId=request-1")
  })

  it("hides the link when the decided TRACKED_DECISION outcome is REJECT", async () => {
    findFirst.mockResolvedValue(decidedRequest("TRACKED_DECISION", "REJECT"))
    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))
    expect(screen.queryByRole("link", { name: /send to agent/i })).toBeNull()
  })

  it("hides the link when the decided TRACKED_DECISION outcome is REQUEST_CHANGES", async () => {
    findFirst.mockResolvedValue(decidedRequest("TRACKED_DECISION", "REQUEST_CHANGES"))
    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))
    expect(screen.queryByRole("link", { name: /send to agent/i })).toBeNull()
  })

  it("hides the link on a decided banner for a different gateType (BUILDING_INVESTMENT), even with outcome APPROVE", async () => {
    findFirst.mockResolvedValue(decidedRequest("BUILDING_INVESTMENT", "APPROVE"))
    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))
    expect(screen.queryByRole("link", { name: /send to agent/i })).toBeNull()
  })
})
