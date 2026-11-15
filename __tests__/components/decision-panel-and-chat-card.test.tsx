// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push, replace: mocks.replace }),
  usePathname: () => "/acme/product/agent",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({
  decideReviewAction: mocks.decide,
}))

import { PanelProvider } from "@/components/panels/panel-context"
import { DecisionPanel, type DecisionPanelData } from "@/components/panels/decision-panel"
import { TrackedDecisionChatCard } from "@/components/agent/tracked-decision-card"

const REQ_ID = "11111111-2222-4333-8444-555555555555"

function makeReviewPayload(overrides: Partial<DecisionPanelData> = {}): DecisionPanelData {
  return {
    id: REQ_ID,
    displayId: "DEC-19",
    workspaceId: "ws-1",
    state: "PENDING",
    isTracked: true,
    readOnlyLegacy: false,
    stale: false,
    title: "Should we launch Inbox Triage?",
    summary: null,
    context: "## Context\n\nReviewers need the ballot above the fold instead of buried beneath long prose.",
    linkedTo: { type: "SOLUTION", id: "22222222-3333-4444-8555-666666666666", title: "Decision redesign" },
    sourcesCount: 2,
    requester: { type: "AGENT", id: "agent-1", name: "Compass PM" },
    revisionId: "rev-1",
    revisionNumber: 1,
    createdAt: "2026-11-15T12:00:00.000Z",
    fingerprint: "fp-1",
    canDecide: true,
    options: [
      { id: "opt-approve", label: "Approve", outcomeClass: "APPROVE", actionKey: "APPROVE", description: null },
      { id: "opt-changes", label: "Request changes", outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES", description: null },
      { id: "opt-reject", label: "Reject", outcomeClass: "REJECT", actionKey: "REJECT", description: null },
    ],
    offeredChoices: [],
    questions: [],
    decision: null,
    ...overrides,
  }
}

describe("DecisionPanel slide-over drawer", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders DEC-n display ID, semantic Rejected status & danger banner, and resolved decider name", async () => {
    const payload = makeReviewPayload({
      state: "DECIDED",
      decision: {
        label: "Reject",
        description: null,
        outcomeClass: "REJECT",
        actorRole: "ADMIN",
        decidedByName: "Rick Bowman",
        decidedAt: "2026-11-15T15:00:00.000Z",
        rationale: "Scope is too broad for Q4.",
        answers: [],
      },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: payload }) }))

    render(
      <PanelProvider orgSlug="acme" workspaceSlug="product">
        <DecisionPanel id={REQ_ID} orgSlug="acme" workspaceSlug="product" />
      </PanelProvider>,
    )

    expect(await screen.findByTestId("display-id")).toHaveTextContent("DEC-19")
    expect(screen.getByText("Rejected")).toBeInTheDocument()
    const banner = screen.getByTestId("decision-outcome-banner")
    expect(banner).toHaveAttribute("data-outcome", "REJECT")
    expect(banner).toHaveTextContent("Decision recorded: Reject by Rick Bowman")
    expect(screen.getByRole("link", { name: /Open full page/i })).toHaveAttribute("href", "/acme/product/reviews/DEC-19")
  })
})

describe("TrackedDecisionChatCard (Chat Option 3 Quick Card)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.decide.mockResolvedValue(undefined)
  })

  it("renders nothing when /api/panels/review returns 404 (e.g. foreign workspace or TOOL_APPROVAL)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    const { container } = render(<TrackedDecisionChatCard requestId={REQ_ID} basePath="/acme/product" />)
    await waitFor(() => expect(screen.queryByTestId("tracked-decision-card-loading")).toBeNull())
    expect(container.textContent).toBe("")
  })

  it("supports 1-click inline Approve for binary decisions and opens DecisionPanel on 'Read brief & decide'", async () => {
    const pending = makeReviewPayload()
    const decided = makeReviewPayload({
      state: "DECIDED",
      decision: {
        label: "Approve",
        description: null,
        outcomeClass: "APPROVE",
        actorRole: "ADMIN",
        decidedByName: "Rick Bowman",
        decidedAt: "2026-11-15T15:30:00.000Z",
        rationale: "",
        answers: [],
      },
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: pending }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: decided }) })
    vi.stubGlobal("fetch", fetchMock)

    render(
      <PanelProvider orgSlug="acme" workspaceSlug="product">
        <TrackedDecisionChatCard requestId={REQ_ID} basePath="/acme/product" />
      </PanelProvider>,
    )

    const card = await screen.findByTestId("tracked-decision-chat-card")
    expect(card).toHaveTextContent("DEC-19")
    expect(card).toHaveTextContent("Awaiting review")
    expect(card).toHaveTextContent("Reviewers need the ballot above the fold")

    fireEvent.click(screen.getByRole("button", { name: /Read brief & decide/i }))
    expect(mocks.push).toHaveBeenCalledWith(`/acme/product/agent?detail=review%3A${REQ_ID}`, { scroll: false })

    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(mocks.decide).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        revisionId: "rev-1",
        fingerprint: "fp-1",
        optionId: "opt-approve",
        rationale: "",
      }),
    )
    expect(await screen.findByText("Approved")).toBeInTheDocument()
  })

  it("renders inline quick choice radios for single-option decisions and hands multi-question decisions to the drawer", async () => {
    const withChoices = makeReviewPayload({
      options: [
        { id: "c1", label: "Ship Option 3", outcomeClass: "APPROVE", actionKey: "CHOICE_1", description: null },
        { id: "c2", label: "Wait for Q1", outcomeClass: "APPROVE", actionKey: "CHOICE_2", description: null },
        { id: "chg", label: "Request changes", outcomeClass: "REQUEST_CHANGES", actionKey: "REQUEST_CHANGES", description: null },
      ],
      offeredChoices: [
        { id: "c1", label: "Ship Option 3", description: null },
        { id: "c2", label: "Wait for Q1", description: null },
      ],
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: withChoices }) }))

    const { unmount } = render(
      <PanelProvider orgSlug="acme" workspaceSlug="product">
        <TrackedDecisionChatCard requestId={REQ_ID} basePath="/acme/product" />
      </PanelProvider>,
    )

    await screen.findByTestId("tracked-decision-chat-card")
    const confirmBtn = screen.getByRole("button", { name: "Confirm choice" })
    expect(confirmBtn).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "Ship Option 3" }))
    expect(confirmBtn).not.toBeDisabled()
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ optionId: "c1" })))
    unmount()

    const multiQuestion = makeReviewPayload({
      questions: [
        { header: "Surface", question: "Where should it open?", options: [{ label: "Drawer" }, { label: "Full page" }] },
        { question: "Rollout?", options: [{ label: "Immediate" }, { label: "Staged" }] },
      ],
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: multiQuestion }) }))
    render(
      <PanelProvider orgSlug="acme" workspaceSlug="product">
        <TrackedDecisionChatCard requestId={REQ_ID} basePath="/acme/product" />
      </PanelProvider>,
    )
    await screen.findByTestId("tracked-decision-chat-card")
    expect(screen.getByText("2 questions require answers")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Answer in drawer/i }))
    expect(mocks.push).toHaveBeenCalledWith(`/acme/product/agent?detail=review%3A${REQ_ID}`, { scroll: false })
  })
})
