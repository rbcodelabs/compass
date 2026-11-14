// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
import type { AgentBoardCard } from "@/lib/agent-board"

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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ cards: [], squads: [] }), { status: 200 })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AgentBoard rich card anatomy, live SSE patches, search, and Squad grouping", () => {
  const freshHeartbeat = new Date().toISOString()
  const staleHeartbeat = new Date(Date.now() - 120_000).toISOString()

  const cards: AgentBoardCard[] = [
    {
      id: "c-working",
      title: "Implement rich board cards",
      messageCount: 4,
      runStatus: "RUNNING",
      lastActivityAt: freshHeartbeat,
      lastHeartbeatAt: freshHeartbeat,
      reviewedAt: null,
      squad: { id: "sq-core", name: "Core UX", color: "#6366f1" },
      currentActivity: "Running vitest suite · agent-board",
      subtasks: {
        completed: 2,
        total: 6,
        items: [
          { id: "s1", title: "Add migration 119", status: "completed" },
          { id: "s2", title: "Batch subtasks in listAgentBoardCards", status: "completed" },
          { id: "s3", title: "Stream patches over SSE", status: "in_progress" },
          { id: "s4", title: "Render subtask checklist", status: "pending" },
          { id: "s5", title: "Add search and Squad toggle", status: "pending" },
        ],
      },
    },
    {
      id: "c-stale",
      title: "Long sandbox build",
      messageCount: 2,
      runStatus: "RUNNING",
      lastActivityAt: staleHeartbeat,
      lastHeartbeatAt: staleHeartbeat,
      reviewedAt: null,
    },
    {
      id: "c-review",
      title: "Shipped PR #570",
      messageCount: 5,
      runStatus: "SUCCEEDED",
      lastActivityAt: freshHeartbeat,
      reviewedAt: null,
      summary: "Delivered live SSE board stream and rich card anatomy with zero regressions.",
      prUrl: "https://github.com/rbcodelabs/compass/pull/570",
      linkedObjects: [
        { entityType: "OPPORTUNITY", entityId: "o1", title: "Multi-agent orchestration", kind: "CREATED" },
        { entityType: "SOLUTION", entityId: "sol1", title: "Agent Board + Orchestrator", kind: "CREATED" },
      ],
      linkedObjectCount: 3,
    },
  ]

  it("renders inline subtasks, live activity, stale heartbeat state, idle summary, PR badge, and linked chips", () => {
    render(
      <AgentBoard
        workspaceId="w1"
        basePath="/org/ws"
        initialCards={cards}
        squads={[{ id: "sq-core", name: "Core UX", color: "#6366f1" }]}
        onOpenConversation={() => undefined}
      />,
    )

    const workingCard = document.querySelector<HTMLElement>('[data-board-card="c-working"]')!
    expect(within(workingCard).getByTestId("board-card-squad-badge")).toHaveTextContent("Core UX")
    expect(within(workingCard).getByTestId("board-card-live-activity")).toHaveTextContent("Running vitest suite · agent-board")
    expect(within(workingCard).getByTestId("board-card-subtasks")).toHaveTextContent("2/6")
    expect(within(workingCard).getByTestId("board-card-subtasks")).toHaveTextContent("Stream patches over SSE")
    expect(within(workingCard).getByTestId("board-card-subtasks")).toHaveTextContent("+1 more")

    // Stale heartbeat pauses spinner and displays Delayed cue
    const staleCard = document.querySelector<HTMLElement>('[data-board-card="c-stale"]')!
    expect(staleCard.querySelector('[data-stale="true"]')).not.toBeNull()
    expect(staleCard).toHaveTextContent("Delayed")

    // Idle card shows summary, PR #570 badge, linked chips, and +1 overflow
    const reviewCard = document.querySelector<HTMLElement>('[data-board-card="c-review"]')!
    expect(within(reviewCard).getByTestId("board-card-summary")).toHaveTextContent("Delivered live SSE board stream")
    expect(within(reviewCard).getByTestId("board-card-pr-badge")).toHaveTextContent("PR #570")
    expect(within(reviewCard).getAllByTestId("board-card-linked-chip")).toHaveLength(2)
    expect(reviewCard).toHaveTextContent("+1")
  })

  it("applies live SSE patch events, filters by search query, and switches between Status and Squad columns", () => {
    render(
      <AgentBoard
        workspaceId="w1"
        basePath="/org/ws"
        initialCards={cards}
        squads={[
          { id: "sq-core", name: "Core UX", color: "#6366f1" },
          { id: "sq-infra", name: "Runtime Infra", color: "#10b981" },
        ]}
        onOpenConversation={() => undefined}
      />,
    )

    expect(FakeEventSource.instances).toHaveLength(1)
    const stream = FakeEventSource.instances[0]

    // Emit live patch updating c-working's activity
    act(() => {
      stream.emit("patch", {
        upserts: [{ ...cards[0], currentActivity: "All 48 tests green" }],
        removedIds: [],
        cursor: new Date().toISOString(),
      })
    })
    expect(screen.getByText("All 48 tests green")).toBeInTheDocument()

    // Search filters by subtask title
    const search = screen.getByRole("searchbox", { name: "Search agent threads" })
    fireEvent.change(search, { target: { value: "Stream patches over SSE" } })
    expect(document.querySelector('[data-board-card="c-working"]')).not.toBeNull()
    expect(document.querySelector('[data-board-card="c-review"]')).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(document.querySelector('[data-board-card="c-review"]')).not.toBeNull()

    // Switch to Squad grouping
    fireEvent.click(screen.getByRole("button", { name: "Squad" }))
    const squadBoard = screen.getByRole("region", { name: "Agent conversations by squad" })
    const headings = Array.from(squadBoard.querySelectorAll("section > header h3")).map((h) => h.textContent)
    expect(headings).toEqual(["Core UX", "Runtime Infra", "No squad"])
  })
})
