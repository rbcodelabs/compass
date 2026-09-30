// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { auth, findFirst, findArtifacts, linkedArtifacts, findTaskLinks, eligibleAssignees } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirst: vi.fn(),
  findArtifacts: vi.fn(), linkedArtifacts: vi.fn(),
  // Direction B: the decided branch now loads follow-through data.
  findTaskLinks: vi.fn(), eligibleAssignees: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ reviewRequest: { findFirst }, artifact: { findMany: findArtifacts }, taskLink: { findMany: findTaskLinks } }) }))
vi.mock("@/lib/artifacts", () => ({ getDecisionArtifacts: linkedArtifacts }))
vi.mock("@/lib/task-assignment", () => ({ eligibleTaskAssignees: eligibleAssignees }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ linkArtifactDecision: vi.fn(), unlinkArtifactDecision: vi.fn() }))
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
    findTaskLinks.mockResolvedValue([])
    eligibleAssignees.mockResolvedValue([])
    findArtifacts.mockResolvedValue([{ id: "new", title: "New prototype" }])
    linkedArtifacts.mockResolvedValue([{ id: "linked", title: "Existing prototype", status: "ACTIVE", currentRevision: { revisionNumber: 2 } }])
  })

  it("renders a historical Building investment review as a read-only legacy record", async () => {
    findFirst.mockResolvedValue(reviewRequest("BUILDING_INVESTMENT"))

    render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))

    expect(screen.getByText("Legacy system decision · Building investment")).toBeDefined()
    expect(screen.getByText("This legacy review is read-only.")).toBeDefined()
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

describe("review request page — tracked decisions with custom options", () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    findTaskLinks.mockResolvedValue([])
    eligibleAssignees.mockResolvedValue([])
    findArtifacts.mockResolvedValue([])
    linkedArtifacts.mockResolvedValue([])
  })

  const choiceRows = [
    { id: "c1", actionKey: "CHOICE_1", label: "Ship now", description: "Release this week.", outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 },
    { id: "c2", actionKey: "CHOICE_2", label: "Wait a sprint", description: null, outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 1 },
    { id: "chg", actionKey: "REQUEST_CHANGES", label: "Request changes", description: null, outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 2 },
    { id: "rej", actionKey: "REJECT", label: "Reject", description: null, outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 3 },
  ]
  const standardRows = [
    { id: "a", actionKey: "APPROVE", label: "Approve", description: null, outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 },
    { id: "chg", actionKey: "REQUEST_CHANGES", label: "Request changes", description: null, outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 1 },
    { id: "rej", actionKey: "REJECT", label: "Reject", description: null, outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 2 },
  ]
  const page = async () => render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))

  function withOptions(options: typeof choiceRows, decisionOptionId?: string) {
    const request = reviewRequest("TRACKED_DECISION")
    request.currentRevision.options = options as never[]
    if (decisionOptionId) {
      request.currentRevision.decisions = [{ option: options.find((option) => option.id === decisionOptionId), optionId: decisionOptionId, actorRole: "ADMIN", decidedAt: new Date("2026-09-01T00:00:00Z"), rationale: "Because." }] as never[]
    }
    return request
  }

  it("offers custom options as selectable cards with Request changes and Reject as secondary buttons", async () => {
    findFirst.mockResolvedValue(withOptions(choiceRows))
    await page()
    expect(screen.getAllByRole("radio")).toHaveLength(2)
    expect(screen.getByText("Release this week.")).toBeDefined()
    expect(screen.getByRole("button", { name: "Confirm choice" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  it("keeps Approve / Request changes / Reject as plain buttons when no custom options exist", async () => {
    findFirst.mockResolvedValue(withOptions(standardRows as typeof choiceRows))
    await page()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
    expect(screen.queryByText("Options offered")).toBeNull()
  })

  it("shows the chosen option's label and description once decided, and offers Send to agent (APPROVE outcome)", async () => {
    findFirst.mockResolvedValue(withOptions(choiceRows, "c1"))
    await page()
    expect(screen.getByText(/Decision recorded:/).textContent).toContain("Ship now")
    expect(screen.getAllByText("Release this week.")).toHaveLength(1)
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.getByRole("link", { name: /send to agent/i })).toBeDefined()
  })

  it("shows a chosen option with no description without an empty description line", async () => {
    findFirst.mockResolvedValue(withOptions(choiceRows, "c2"))
    await page()
    expect(screen.getByText(/Decision recorded:/).textContent).toContain("Wait a sprint")
    expect(screen.queryByText("Release this week.")).toBeNull()
  })

  it("shows non-deciders the offered options while the decision waits", async () => {
    const request = withOptions(choiceRows)
    request.workspace.members = [{ id: "member-1", role: "MEMBER" }]
    findFirst.mockResolvedValue(request)
    await page()
    expect(screen.getByText("Waiting for a workspace or organization admin to decide.")).toBeDefined()
    expect(screen.getByText("Options offered")).toBeDefined()
    expect(screen.getByText("Ship now")).toBeDefined()
    expect(screen.getByText("Release this week.")).toBeDefined()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.queryByText("Request changes")).toBeNull()
  })
})

describe("review request page — multi-question decisions", () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    findTaskLinks.mockResolvedValue([])
    eligibleAssignees.mockResolvedValue([])
    findArtifacts.mockResolvedValue([])
    linkedArtifacts.mockResolvedValue([])
  })

  const questions = [
    { header: "Timing", question: "When do we ship?", options: [{ label: "Now", description: "This week." }, { label: "Later" }] },
    { question: "Who announces it?", options: [{ label: "PM" }, { label: "Marketing" }] },
  ]
  const submitOptions = [
    { id: "sub", label: "Submit answers", description: null, outcomeClass: "APPROVE", actionKey: "SUBMIT_ANSWERS" },
    { id: "chg", label: "Request changes", description: null, outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES" },
    { id: "rej", label: "Reject", description: null, outcomeClass: "REJECT", actionKey: "REJECT" },
  ]
  function multiQuestionRequest() {
    const request = reviewRequest("TRACKED_DECISION")
    request.currentRevision.packetJson = JSON.stringify({ ...JSON.parse(request.currentRevision.packetJson), questions })
    request.currentRevision.options = submitOptions as never[]
    return request
  }
  const page = async () => render(await ReviewRequestPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: "request-1" }) }))

  it("shows each question as a radio group with one Submit answers button, disabled until answered", async () => {
    findFirst.mockResolvedValue(multiQuestionRequest())
    await page()
    expect(screen.getAllByRole("group")).toHaveLength(2)
    expect(screen.getAllByRole("radio")).toHaveLength(4)
    expect((screen.getByRole("button", { name: "Submit answers" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDefined()
  })

  it("lists the questions and options for a viewer who cannot decide", async () => {
    const request = multiQuestionRequest()
    request.workspace.members = [{ id: "member-1", role: "MEMBER" }]
    findFirst.mockResolvedValue(request)
    await page()
    expect(screen.getByText("Waiting for a workspace or organization admin to decide.")).toBeDefined()
    expect(screen.getByText("Questions asked")).toBeDefined()
    expect(screen.getByText(/1\. \[Timing\] When do we ship\?/)).toBeDefined()
    expect(screen.getByText(/Marketing/)).toBeDefined()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
  })

  it("shows each question with its chosen answer once decided", async () => {
    const request = multiQuestionRequest()
    request.currentRevision.decisions = [{
      option: submitOptions[0], actorRole: "ADMIN", decidedAt: new Date("2026-09-01T00:00:00Z"), rationale: null,
      answersJson: JSON.stringify([{ questionIndex: 0, question: "When do we ship?", chosenOption: "Now" }, { questionIndex: 1, question: "Who announces it?", chosenOption: "PM" }]),
    }] as never[]
    findFirst.mockResolvedValue(request)
    await page()
    const answers = screen.getByRole("list", { name: "Answers" })
    expect(within(answers).getByText(/1\. When do we ship\?/)).toBeDefined()
    expect(within(answers).getByText("Now")).toBeDefined()
    expect(within(answers).getByText(/2\. Who announces it\?/)).toBeDefined()
    expect(within(answers).getByText("PM")).toBeDefined()
    expect(screen.queryAllByRole("radio")).toHaveLength(0)
    expect(screen.getByRole("link", { name: /send to agent/i })).toBeDefined()
  })

  it("shows no answers list when the request was sent back with Request changes", async () => {
    const request = multiQuestionRequest()
    request.currentRevision.decisions = [{ option: submitOptions[1], actorRole: "ADMIN", decidedAt: new Date("2026-09-01T00:00:00Z"), rationale: "Rework.", answersJson: null }] as never[]
    findFirst.mockResolvedValue(request)
    await page()
    expect(screen.queryByRole("list", { name: "Answers" })).toBeNull()
    expect(screen.getByRole("link", { name: /create revised request/i })).toBeDefined()
  })
})
