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

import { QuestionPromptCard } from "@/components/agent/question-prompt-card"
import { AgentBoard } from "@/components/agent/agent-board"
import type { AgentBoardCard, AgentBoardCardPendingQuestion } from "@/lib/agent-board"

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

const sampleQuestion: AgentBoardCardPendingQuestion = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "conv-awaiting",
  runId: "run-1",
  header: "Rollout Scope",
  question: "How should we roll out the interactive inbox?",
  options: [
    { label: "Phased beta", description: "Enable for internal workspaces first" },
    { label: "General availability", description: "Enable for all workspaces immediately" },
  ],
  multiSelect: false,
  allowOther: true,
  status: "PENDING",
  answerText: null,
  createdAt: "2026-11-14T12:00:00.000Z",
}

beforeEach(() => {
  window.localStorage.clear()
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

describe("QuestionPromptCard and interactive AgentBoard columns", () => {
  it("preserves half-typed custom drafts across parent re-renders and submits answers cleanly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          itemId: sampleQuestion.id,
          conversationId: "conv-awaiting",
          delivery: "live_run",
          remainingPendingCount: 0,
          runId: "run-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const onAnswered = vi.fn()
    const { rerender } = render(<QuestionPromptCard questions={[sampleQuestion]} onAnswered={onAnswered} />)

    fireEvent.click(screen.getByRole("button", { name: /Other…/i }))
    const input = screen.getByPlaceholderText("Type a custom answer…")
    fireEvent.change(input, { target: { value: "Canary 25% then GA" } })

    // Simulate a live SSE/poll re-render creating a fresh question object reference with the same id
    rerender(<QuestionPromptCard questions={[{ ...sampleQuestion }]} onAnswered={onAnswered} />)
    expect(screen.getByPlaceholderText("Type a custom answer…")).toHaveValue("Canary 25% then GA")

    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/agent/inbox/${sampleQuestion.id}/answer`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ answerText: "Canary 25% then GA" }),
      }),
    )
    await waitFor(() => expect(onAnswered).toHaveBeenCalledTimes(1))
  })

  it("renders Awaiting inline QuestionPromptCard and Waiting wakeup countdown with 1-click Cancel on AgentBoard", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && url.includes("/wakeups")) {
        return new Response(JSON.stringify({ canceledCount: 1 }), { status: 200 })
      }
      return new Response(JSON.stringify({ cards: [] }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const cards: AgentBoardCard[] = [
      {
        id: "conv-awaiting",
        title: "Clarify pricing tier",
        messageCount: 3,
        runStatus: "RUNNING",
        substatus: "AWAITING_QUESTION",
        lastActivityAt: new Date().toISOString(),
        reviewedAt: null,
        pendingQuestions: [sampleQuestion],
      },
      {
        id: "conv-waiting",
        title: "Monitor preview deploy",
        messageCount: 4,
        runStatus: "SUCCEEDED",
        lastActivityAt: new Date().toISOString(),
        reviewedAt: null,
        scheduledWakeup: {
          id: "22222222-2222-4222-8222-222222222222",
          fireAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          delaySeconds: 300,
          reason: "CI pipeline check",
          prompt: "Inspect GitHub check-runs",
        },
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

    const awaitingCol = document.querySelector('[data-board-column="awaiting"]') as HTMLElement
    const waitingCol = document.querySelector('[data-board-column="waiting"]') as HTMLElement
    expect(awaitingCol).not.toBeNull()
    expect(waitingCol).not.toBeNull()

    // Clicking an option inside the inline QuestionPromptCard must NOT navigate the card link
    fireEvent.click(within(awaitingCol).getByRole("button", { name: /Phased beta/i }))
    expect(onOpen).not.toHaveBeenCalled()

    // Waiting column shows countdown + reason and supports 1-click Cancel
    const wakeupStrip = within(waitingCol).getByTestId("board-card-wakeup")
    expect(wakeupStrip).toHaveTextContent(/Resumes in \d+m — CI pipeline check/)

    fireEvent.click(within(waitingCol).getByTestId("board-card-wakeup-cancel"))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/agent/conversations/conv-waiting/wakeups?"),
        expect.objectContaining({ method: "DELETE" }),
      ),
    )
    expect(onOpen).not.toHaveBeenCalled()
  })
})
