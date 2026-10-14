// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), getWorkspace: vi.fn(), list: vi.fn(), members: vi.fn(), orgMembers: vi.fn() }))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.getWorkspace }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspaceMember: { findMany: mocks.members }, organizationMember: { findMany: mocks.orgMembers } }) }))
vi.mock("@/lib/tracked-decisions", async () => {
  const types = await import("@/lib/tracked-decision-types")
  return { listTrackedDecisions: mocks.list, TRACKED_SUBJECT_LABELS: types.TRACKED_SUBJECT_LABELS, TRACKED_SUBJECT_TYPES: types.TRACKED_SUBJECT_TYPES }
})
vi.mock("@/components/decisions/decisions-filters", () => ({ DecisionsFilters: () => null }))
vi.mock("@/components/decisions/decisions-tabs", () => ({ DecisionsTabs: () => null }))
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => null }))
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT") }),
}))

import DecisionsPage from "@/app/[orgSlug]/[workspaceSlug]/decisions/page"

const option = (actionKey: string, label: string, outcomeClass: string) => ({ id: actionKey, actionKey, label, outcomeClass })
function row(id: string, title: string, chosen: ReturnType<typeof option> | null) {
  return {
    id, state: chosen ? "DECIDED" : "PENDING", gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", updatedAt: new Date("2026-09-01T00:00:00Z"),
    currentRevision: {
      title, summary: "Context.", packetJson: JSON.stringify({ entity: { type: "SOLUTION" } }),
      decisions: chosen ? [{ actorUserId: "user-1", option: chosen }] : [],
    },
  }
}

describe("decisions list page", () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.getWorkspace.mockResolvedValue({ id: "ws-1", organizationId: "org-1" })
    mocks.members.mockResolvedValue([{ userId: "user-1", user: { name: "Rick", email: "rick@example.com" } }])
    mocks.orgMembers.mockResolvedValue([])
  })

  const renderPage = async () => render(await DecisionsPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }), searchParams: Promise.resolve({ tab: "decided" }) }))

  it("shows the chosen custom option next to an Approved outcome", async () => {
    mocks.list.mockResolvedValue({ requests: [row("r1", "Which plan?", option("CHOICE_1", "Ship now", "APPROVE"))], total: 1, page: 1, pageSize: 20, pageCount: 1 })
    await renderPage()
    expect(screen.getByText("Approved")).toBeDefined()
    expect(screen.getByText("Chosen:")).toBeDefined()
    expect(screen.getByText("Ship now")).toBeDefined()
  })

  it("renders standard outcomes exactly as before, with no chosen line", async () => {
    mocks.list.mockResolvedValue({ requests: [row("r1", "Plain", option("APPROVE", "Approve", "APPROVE")), row("r2", "Pushback", option("REJECT", "Reject", "REJECT")), row("r3", "Open", null)], total: 3, page: 1, pageSize: 20, pageCount: 1 })
    await renderPage()
    expect(screen.getByText("Approved")).toBeDefined()
    expect(screen.getByText("Rejected")).toBeDefined()
    expect(screen.getByText("Awaiting review")).toBeDefined()
    expect(screen.queryByText("Chosen:")).toBeNull()
  })

  it("forwards the outcome filter unchanged so choosing an option still counts as APPROVE", async () => {
    mocks.list.mockResolvedValue({ requests: [], total: 0, page: 1, pageSize: 20, pageCount: 1 })
    render(await DecisionsPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }), searchParams: Promise.resolve({ tab: "decided", outcome: "APPROVE" }) }))
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ outcome: "APPROVE", tab: "DECIDED" }))
  })
})

describe("decisions list page — multi-question answers", () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.getWorkspace.mockResolvedValue({ id: "ws-1", organizationId: "org-1" })
    mocks.members.mockResolvedValue([{ userId: "user-1", user: { name: "Rick", email: "rick@example.com" } }])
    mocks.orgMembers.mockResolvedValue([])
  })

  it("shows each question and its chosen answer on a decided multi-question request", async () => {
    const decided = row("r1", "Plan the launch", option("SUBMIT_ANSWERS", "Submit answers", "APPROVE"))
    decided.currentRevision.decisions = [{ actorUserId: "user-1", option: option("SUBMIT_ANSWERS", "Submit answers", "APPROVE"), answersJson: JSON.stringify([{ questionIndex: 0, question: "When do we ship?", chosenOption: "Now" }, { questionIndex: 1, question: "Who announces it?", chosenOption: "PM" }]) }] as never[]
    mocks.list.mockResolvedValue({ requests: [decided], total: 1, page: 1, pageSize: 20, pageCount: 1 })
    render(await DecisionsPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }), searchParams: Promise.resolve({ tab: "decided" }) }))
    const answers = screen.getByRole("list", { name: "Answers" })
    expect(answers.textContent).toContain("When do we ship?")
    expect(answers.textContent).toContain("Now")
    expect(answers.textContent).toContain("Who announces it?")
    expect(answers.textContent).toContain("PM")
    expect(screen.getByText("Approved")).toBeDefined()
    expect(screen.queryByText("Chosen:")).toBeNull()
  })

  it("renders no answers list for a pending or answer-less request", async () => {
    mocks.list.mockResolvedValue({ requests: [row("r1", "Open", null), row("r2", "Plain", option("APPROVE", "Approve", "APPROVE"))], total: 2, page: 1, pageSize: 20, pageCount: 1 })
    render(await DecisionsPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }), searchParams: Promise.resolve({ tab: "decided" }) }))
    expect(screen.queryByRole("list", { name: "Answers" })).toBeNull()
  })
})
