// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { useState } from "react"

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
import { ChildAgentTimeline } from "@/components/agent/child-agent-timeline"
import { SubagentTeamPill } from "@/components/agent/composer/subagent-team-pill"
import type { AgentBoardCard } from "@/lib/agent-board"
import type { SerializedChildAgentRun } from "@/lib/agent/child-agent-tree"

class FakeEventSource {
  url: string
  constructor(url: string) {
    this.url = url
  }
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  window.localStorage.clear()
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

const sampleRuns: SerializedChildAgentRun[] = [
  {
    id: "child-root",
    conversationId: "conv-1",
    runId: "run-1",
    nativeAgentId: "nat-root",
    parentChildRunId: null,
    parentNativeAgentId: null,
    role: "Lead Architect",
    description: "Coordinate schema and UI changes",
    status: "RUNNING",
    currentActivity: "Read file · path: prisma/schema.prisma",
    stepCount: 2,
    steps: [
      { id: "st-1", label: "Read file", status: "done", detail: "path: lib/agent-runs.ts", result: "Loaded 1150 lines" },
      { id: "st-2", label: "Read file", status: "running", detail: "path: prisma/schema.prisma" },
    ],
    resultSummary: null,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: null,
    updatedAt: new Date().toISOString(),
  },
  {
    id: "child-nested",
    conversationId: "conv-1",
    runId: "run-1",
    nativeAgentId: "nat-nested",
    parentChildRunId: "child-root",
    parentNativeAgentId: "nat-root",
    role: "SQL Verifier",
    description: "Audit Aurora DSQL index constraints",
    status: "SUCCEEDED",
    currentActivity: null,
    stepCount: 1,
    steps: [{ id: "st-n1", label: "Search code", status: "done", detail: "query: ASYNC_WAIT_MIGRATIONS", result: "Matched runner.ts" }],
    resultSummary: "Verified all three indexes use `CREATE INDEX ASYNC IF NOT EXISTS`.",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

function InteractiveHarness() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = sampleRuns.find((r) => r.id === selectedId) ?? null
  return (
    <div>
      {selected ? (
        <ChildAgentTimeline run={selected} allRuns={sampleRuns} onSelectChildRun={setSelectedId} />
      ) : (
        <div data-testid="main-pane">Main transcript visible</div>
      )}
      <SubagentTeamPill runs={sampleRuns} selectedChildRunId={selectedId} onSelectChildRun={setSelectedId} />
    </div>
  )
}

describe("SubagentTeamPill, ChildAgentTimeline, and Board child-agent badges", () => {
  it("opens the hierarchy popover, supports keyboard navigation, drills into nested timelines, and returns via sticky breadcrumbs", () => {
    render(<InteractiveHarness />)

    expect(screen.getByTestId("main-pane")).toBeInTheDocument()
    const pill = screen.getByTestId("composer-subagent-pill")
    expect(pill).toHaveTextContent("1 agent working")

    fireEvent.click(pill)
    const popover = screen.getByTestId("subagent-team-popover")
    const items = within(popover).getAllByTestId("subagent-tree-item")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute("aria-level", "1")
    expect(items[0]).toHaveTextContent("Lead Architect")
    expect(items[1]).toHaveAttribute("aria-level", "2")
    expect(items[1]).toHaveTextContent("SQL Verifier")

    // Select Lead Architect from tree
    fireEvent.click(items[0])
    expect(screen.queryByTestId("main-pane")).toBeNull()
    expect(screen.getByTestId("child-agent-timeline")).toBeInTheDocument()
    expect(screen.getByTestId("breadcrumb-current-agent")).toHaveTextContent("Lead Architect")
    expect(screen.getByTestId("child-agent-live-activity")).toHaveTextContent("Read file · path: prisma/schema.prisma")

    // Drill deeper into delegated child sub-agent directly from timeline
    const nestedBtn = screen.getByTestId("child-agent-nested-item")
    expect(nestedBtn).toHaveTextContent("SQL Verifier")
    fireEvent.click(nestedBtn)

    // Breadcrumb shows Main conversation > Lead Architect > SQL Verifier
    expect(screen.getByTestId("breadcrumb-ancestor-agent")).toHaveTextContent("Lead Architect")
    expect(screen.getByTestId("breadcrumb-current-agent")).toHaveTextContent("SQL Verifier")
    expect(screen.getByTestId("child-agent-result")).toHaveTextContent("CREATE INDEX ASYNC IF NOT EXISTS")

    // Click ancestor breadcrumb to step back up to Lead Architect
    fireEvent.click(screen.getByTestId("breadcrumb-ancestor-agent"))
    expect(screen.getByTestId("breadcrumb-current-agent")).toHaveTextContent("Lead Architect")

    // Click Main conversation breadcrumb to return to main transcript
    fireEvent.click(screen.getByTestId("breadcrumb-main-conversation"))
    expect(screen.getByTestId("main-pane")).toBeInTheDocument()
  })

  it("renders non-nested ◉ N child-agent badges on Board cards, filters by child role, and triggers openTeam", () => {
    const onOpen = vi.fn()
    const nowIso = new Date().toISOString()
    const cards: AgentBoardCard[] = [
      {
        id: "c-team",
        title: "Multi-agent schema migration",
        messageCount: 3,
        runStatus: "RUNNING",
        lastActivityAt: nowIso,
        lastHeartbeatAt: nowIso,
        reviewedAt: null,
        childAgents: { total: 3, active: 1, failed: 0, roles: ["Lead Architect", "SQL Verifier"] },
      },
      {
        id: "c-solo",
        title: "Solo chat without subagents",
        messageCount: 2,
        runStatus: "SUCCEEDED",
        lastActivityAt: nowIso,
        reviewedAt: null,
      },
    ]

    render(<AgentBoard workspaceId="w1" basePath="/org/ws" initialCards={cards} onOpenConversation={onOpen} />)

    const teamCard = document.querySelector<HTMLElement>('[data-board-card="c-team"]')!
    // Ensure valid HTML: zero nested <a> tags inside BoardCard
    expect(teamCard.querySelectorAll("a a")).toHaveLength(0)

    const badge = within(teamCard).getByTestId("board-card-child-agents")
    expect(badge).toHaveTextContent("◉")
    expect(badge).toHaveTextContent("3")

    // Search by sub-agent role filters down to c-team
    const search = screen.getByRole("searchbox", { name: "Search agent threads" })
    fireEvent.change(search, { target: { value: "SQL Verifier" } })
    expect(document.querySelector('[data-board-card="c-team"]')).not.toBeNull()
    expect(document.querySelector('[data-board-card="c-solo"]')).toBeNull()

    // Clicking ◉ 3 opens with { openTeam: true }
    fireEvent.click(badge)
    expect(onOpen).toHaveBeenCalledWith("c-team", { openTeam: true })
  })
})
