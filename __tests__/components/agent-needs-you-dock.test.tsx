// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        onClick?.()
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}))

import { AgentBoard } from "@/components/agent/agent-board"
import { DecisionCard } from "@/components/agent/decision-card"
import { ProposedReplyCard, clearProposedReplyDraft } from "@/components/agent/proposed-reply-card"
import { rewriteThreadWikilinks, parseThreadLinkHref } from "@/lib/orchestrator/thread-links"
import type { AgentBoardCard, AgentBoardCardPendingDecision } from "@/lib/agent-board"

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }

  emit(type: string, data: unknown) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(data) } as MessageEvent)
    }
  }

  close() {
    this.closed = true
  }
}

const sampleDecision: AgentBoardCardPendingDecision = {
  id: "dddd1111-1111-4111-8111-111111111111",
  conversationId: "conv-decision",
  sourceConversationId: "conv-orch",
  header: "Database Migration",
  question: "Should we apply migration 123 before or after preview deploy?",
  options: [
    { label: "Before deploy", description: "Run migration in pre-deploy step" },
    { label: "After deploy", description: "Run via /api/admin/migrate post-deploy" },
  ],
  multiSelect: false,
  allowOther: true,
  status: "PENDING",
  answerText: null,
  createdAt: "2026-11-14T15:00:00.000Z",
}

beforeEach(() => {
  window.localStorage?.clear?.()
  clearProposedReplyDraft("conv-reply")
  FakeEventSource.instances = []
  window.matchMedia = ((query: string) => ({
    matches: query.includes("768"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  vi.stubGlobal("EventSource", FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Needs you lane, draft-safe supervision cards, thread links, and OrchestratorDock", () => {
  it("rewrites [[thread:<id>|Title]] wikilinks into parseable thread hrefs", () => {
    const md = "Checked [[thread:conv-123|Auth race fix]] and [[thread:abcd1234-5678]]."
    const rewritten = rewriteThreadWikilinks(md)
    expect(rewritten).toContain("[Auth race fix](?c=conv-123#thread-link)")
    expect(rewritten).toContain("[Thread abcd1234](?c=abcd1234-5678#thread-link)")
    expect(parseThreadLinkHref("?c=conv-123#thread-link")).toBe("conv-123")
    expect(parseThreadLinkHref("https://example.com")).toBeNull()
  })

  it("preserves half-edited ProposedReplyCard drafts across SSE re-renders and submits Approve & Send", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          conversationId: "conv-reply",
          text: "Edited reply: run vitest and open PR",
          runId: "run-99",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const onApproved = vi.fn()
    const initialReply = {
      text: "Original staged reply",
      generatedAt: "2026-11-14T15:00:00.000Z",
      authorOrchestratorId: "orch-1",
    }

    const { rerender } = render(
      <ProposedReplyCard
        workspaceId="33333333-3333-4333-8333-333333333333"
        conversationId="conv-reply"
        proposedReply={initialReply}
        onApproved={onApproved}
      />,
    )

    fireEvent.click(screen.getByTestId("proposed-reply-edit"))
    const textarea = screen.getByTestId("proposed-reply-textarea")
    fireEvent.change(textarea, { target: { value: "Edited reply: run vitest and open PR" } })

    // Simulate a live SSE patch re-rendering with a new proposedReply object reference
    rerender(
      <ProposedReplyCard
        workspaceId="33333333-3333-4333-8333-333333333333"
        conversationId="conv-reply"
        proposedReply={{ ...initialReply }}
        onApproved={onApproved}
      />,
    )
    expect(screen.getByTestId("proposed-reply-textarea")).toHaveValue("Edited reply: run vitest and open PR")

    fireEvent.click(screen.getByTestId("proposed-reply-approve"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/conversations/conv-reply/supervision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "approve_proposed_reply",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          text: "Edited reply: run vitest and open PR",
        }),
      }),
    )
    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1))
  })

  it("preserves DecisionCard drafts across re-renders and submits decision answers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          itemId: sampleDecision.id,
          conversationId: "conv-decision",
          targetConversationId: "conv-orch",
          formattedMessage: `Decision Database Migration [${sampleDecision.id}]: Before deploy`,
          runId: "run-orch-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const onAnswered = vi.fn()
    const { rerender } = render(
      <DecisionCard conversationId="conv-decision" decisions={[sampleDecision]} onAnswered={onAnswered} />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Before deploy/i }))

    // Re-render with fresh object reference
    rerender(
      <DecisionCard conversationId="conv-decision" decisions={[{ ...sampleDecision }]} onAnswered={onAnswered} />,
    )

    fireEvent.click(screen.getByTestId("decision-card-submit"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/conversations/conv-decision/supervision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "answer_decision",
          itemId: sampleDecision.id,
          answerText: "Before deploy",
        }),
      }),
    )
    await waitFor(() =>
      expect(onAnswered).toHaveBeenCalledWith(
        expect.objectContaining({
          targetConversationId: "conv-orch",
        }),
      ),
    )
  })

  it("renders Needs you column, Only needs you filter, ManagerNotesDisclosure, and OrchestratorDock with [[thread:<id>|Title]] highlight", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/agent/orchestrator/dock")) {
        return new Response(
          JSON.stringify({
            orchestratorId: "orch-ws-1",
            conversationId: "conv-orch",
            title: "Workspace Orchestrator",
            enabled: true,
            runStatus: "SUCCEEDED",
            currentActivity: null,
            messages: [
              {
                id: "msg-1",
                role: "assistant",
                content: "Staged a reply on [[thread:conv-needs-you|API Rate Limiter]].",
                createdAt: "2026-11-14T15:02:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response(JSON.stringify({ cards: [] }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const cards: AgentBoardCard[] = [
      {
        id: "conv-needs-you",
        title: "API Rate Limiter",
        messageCount: 5,
        runStatus: "SUCCEEDED",
        lastActivityAt: "2026-11-14T15:01:00.000Z",
        reviewedAt: null,
        proposedReply: {
          text: "Ship the token-bucket limiter behind a feature flag.",
          generatedAt: "2026-11-14T15:01:00.000Z",
          authorOrchestratorId: "orch-ws-1",
        },
        managerNotes: {
          text: "v2 | state=awaiting_user | cursor=2026-11-14T15:01:00.000Z | verified=yes\nReady for feature-flag rollout.",
          updatedAt: "2026-11-14T15:01:00.000Z",
          sourceOrchestratorId: "orch-ws-1",
        },
      },
      {
        id: "conv-working",
        title: "Worker Pool Tuning",
        messageCount: 2,
        runStatus: "RUNNING",
        currentActivity: "Running load benchmarks",
        lastActivityAt: "2026-11-14T15:00:00.000Z",
        reviewedAt: null,
      },
    ]

    const onOpen = vi.fn()
    render(
      <AgentBoard
        workspaceId="33333333-3333-4333-8333-333333333333"
        basePath="/acme/core"
        initialCards={cards}
        onOpenConversation={onOpen}
      />,
    )

    const needsYouCol = document.querySelector('[data-board-column="needs_you"]') as HTMLElement
    const workingCol = document.querySelector('[data-board-column="working"]') as HTMLElement
    expect(needsYouCol).not.toBeNull()
    expect(workingCol).not.toBeNull()
    expect(within(needsYouCol).getByText("API Rate Limiter")).toBeInTheDocument()

    // Expand Manager Notes v2 disclosure on the card
    fireEvent.click(within(needsYouCol).getByTestId("manager-notes-toggle"))
    expect(within(needsYouCol).getByTestId("manager-notes-content")).toHaveTextContent(
      /v2 \| state=awaiting_user/,
    )

    // Toggle "Only needs you" filter -> working column becomes empty while needs_you stays populated
    const onlyNeedsYouBtn = screen.getByTestId("agent-board-only-needs-you")
    expect(onlyNeedsYouBtn).toHaveTextContent("1")
    fireEvent.click(onlyNeedsYouBtn)
    expect(within(workingCol).queryByText("Worker Pool Tuning")).toBeNull()
    fireEvent.click(onlyNeedsYouBtn)
    expect(within(workingCol).getByText("Worker Pool Tuning")).toBeInTheDocument()

    // OrchestratorDock orb shows working state and badge count = 1
    const dockOrb = screen.getByTestId("orchestrator-dock-orb")
    expect(dockOrb).toHaveAttribute("data-working", "true")
    expect(screen.getByTestId("orchestrator-dock-badge")).toHaveTextContent("1")

    // Open OrchestratorDock via Cmd+J
    fireEvent.keyDown(window, { key: "j", metaKey: true })
    const sheet = await screen.findByTestId("orchestrator-dock-sheet")
    expect(sheet).toBeInTheDocument()

    // Wait for the orchestrator transcript with [[thread:conv-needs-you|API Rate Limiter]] chip
    const threadChip = await within(sheet).findByTestId("thread-link-chip")
    expect(threadChip).toHaveTextContent("API Rate Limiter")

    // Hovering the thread chip highlights the target board card
    const boardCard = document.querySelector('[data-board-card="conv-needs-you"]') as HTMLElement
    fireEvent.mouseEnter(threadChip)
    expect(boardCard).toHaveAttribute("data-highlighted", "true")

    fireEvent.mouseLeave(threadChip)
    expect(boardCard).not.toHaveAttribute("data-highlighted")

    // Clicking the thread chip opens the conversation
    fireEvent.click(threadChip)
    expect(onOpen).toHaveBeenCalledWith("conv-needs-you")
  })
})
