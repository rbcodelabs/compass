// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const routerPush = vi.fn()
const openPanel = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => "/acme/ws/okrs",
}))
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}))

import { LiveNotificationCardHost } from "@/components/notifications/live-notification-card-host"
import {
  getLiveNotificationCards,
  pushLiveNotificationCard,
  resetLiveNotificationCards,
  type LiveNotificationCard,
} from "@/lib/ui/live-notification-cards"

const fetchMock = vi.fn()

function makeCard(overrides: Partial<LiveNotificationCard> = {}): LiveNotificationCard {
  return {
    id: "card-1",
    orgSlug: "acme",
    workspaceSlug: "ws",
    kind: "ASSIGNED",
    subjectType: "TASK",
    subjectId: "task-uuid-176",
    subjectLabel: "Task",
    displayId: "TASK-176",
    title: "Verify OAuth token refresh across multi-tab sessions",
    path: "tasks/task-uuid-176",
    priority: "HIGH",
    status: "TODO",
    actorType: "USER",
    actorName: "Ada Lovelace",
    action: "assigned this to you",
    sentence: "Ada Lovelace assigned this to you",
    commentSnippet: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  routerPush.mockReset()
  openPanel.mockReset()
  resetLiveNotificationCards()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ marked: 1 }) })
})

afterEach(() => {
  cleanup()
  resetLiveNotificationCards()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("LiveNotificationCardHost (Hybrid Option A + Option C)", () => {
  it("renders Option A Editorial Inset anatomy for human and agent cards and @mention quotes", () => {
    render(<LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />)

    // Human task card
    act(() => {
      pushLiveNotificationCard(makeCard())
    })
    const card = screen.getByTestId("live-notification-card")
    expect(within(card).getByText("AL")).toBeInTheDocument()
    expect(within(card).getByText("Ada Lovelace")).toBeInTheDocument()
    expect(within(card).getByText("TASK-176")).toBeInTheDocument()
    expect(within(card).getByText("High")).toBeInTheDocument()
    expect(within(card).getByText("Todo")).toBeInTheDocument()
    expect(within(card).getByText("Auto-following")).toBeInTheDocument()
    expect(within(card).getByTestId("live-notification-open")).toHaveTextContent("Open in panel")

    // Agent handoff + @mention card
    act(() => {
      resetLiveNotificationCards()
      pushLiveNotificationCard(
        makeCard({
          id: "card-agent",
          kind: "MENTIONED",
          subjectType: "SOLUTION",
          subjectId: "sol-uuid-121",
          subjectLabel: "Solution",
          displayId: "SOL-121",
          priority: "URGENT",
          status: "IN_REVIEW",
          actorType: "AGENT",
          actorName: "Geode Architect",
          action: "mentioned you in a comment",
          sentence: "Geode Architect mentioned you in a comment",
          commentSnippet: "@Rick ready for sign-off on the staging preview.",
        }),
      )
    })

    const agentCard = screen.getByTestId("live-notification-card")
    expect(within(agentCard).getByText("⚙")).toBeInTheDocument()
    expect(within(agentCard).getByText("Agent handoff")).toBeInTheDocument()
    expect(within(agentCard).getByText("Urgent")).toBeInTheDocument()
    expect(within(agentCard).getByText("In review")).toBeInTheDocument()
    expect(within(agentCard).getByText(/ready for sign-off on the staging preview/)).toBeInTheDocument()
    expect(within(agentCard).getByText("Comment thread")).toBeInTheDocument()
  })

  it("opens panel-capable subjects in place via openPanel and marks the notification read", async () => {
    render(<LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />)
    act(() => {
      pushLiveNotificationCard(makeCard())
    })

    fireEvent.click(screen.getByTestId("live-notification-open"))

    expect(openPanel).toHaveBeenCalledWith("task", "task-uuid-176")
    expect(routerPush).not.toHaveBeenCalled()
    expect(getLiveNotificationCards()).toHaveLength(0)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/notifications/read")
    expect(JSON.parse(init.body)).toEqual({
      orgSlug: "acme",
      workspaceSlug: "ws",
      ids: ["card-1"],
    })
  })

  it("navigates via router.push with `Open doc ↗` when subjectType has no side panel (`DOC`)", async () => {
    render(<LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />)
    act(() => {
      pushLiveNotificationCard(
        makeCard({
          id: "doc-card",
          kind: "MENTIONED",
          subjectType: "DOC",
          subjectId: "doc-uuid-9",
          subjectLabel: "Doc",
          displayId: "DOC-9",
          path: "docs/doc-uuid-9",
          priority: null,
          status: null,
        }),
      )
    })

    const openBtn = screen.getByTestId("live-notification-open")
    expect(openBtn).toHaveTextContent("Open doc")
    fireEvent.click(openBtn)

    expect(openPanel).not.toHaveBeenCalled()
    expect(routerPush).toHaveBeenCalledWith("/acme/ws/docs/doc-uuid-9")
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it("marks read and dismisses without opening panel or navigating when `Mark read` is clicked", async () => {
    render(<LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />)
    act(() => {
      pushLiveNotificationCard(makeCard())
    })

    fireEvent.click(screen.getByTestId("live-notification-mark-read"))

    expect(openPanel).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(getLiveNotificationCards()).toHaveLength(0)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it("dismisses transiently without marking read on Dismiss button or 10s countdown, and pauses remaining time while hovered", () => {
    vi.useFakeTimers()
    try {
      render(<LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />)
      act(() => {
        pushLiveNotificationCard(makeCard({ id: "transient-1" }))
      })

      const stack = screen.getByTestId("live-notification-stack")
      const countdown = screen.getByTestId("live-notification-countdown")
      expect(countdown).toHaveAttribute("data-paused", "false")

      // Advance 4s, then hover for 30s — card must NOT auto-dismiss while hovered
      act(() => {
        vi.advanceTimersByTime(4_000)
      })
      fireEvent.mouseEnter(stack)
      expect(countdown).toHaveAttribute("data-paused", "true")
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(getLiveNotificationCards()).toHaveLength(1)

      // Unhover: 6s remain on the 10s timer
      fireEvent.mouseLeave(stack)
      expect(countdown).toHaveAttribute("data-paused", "false")
      act(() => {
        vi.advanceTimersByTime(5_900)
      })
      expect(getLiveNotificationCards()).toHaveLength(1)

      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(getLiveNotificationCards()).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()

      // Explicit Dismiss (X) button also dismisses transiently without marking read
      act(() => {
        pushLiveNotificationCard(makeCard({ id: "transient-2" }))
      })
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }))
      expect(getLiveNotificationCards()).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stacks bursts into Option C collapsible 3D deck (+N more in stack · Expand <-> Collapse stack) with background timers paused while collapsed", () => {
    render(<LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />)
    act(() => {
      pushLiveNotificationCard(makeCard({ id: "c1", title: "Oldest alert" }))
      pushLiveNotificationCard(makeCard({ id: "c2", title: "Middle alert" }))
      pushLiveNotificationCard(makeCard({ id: "c3", title: "Newest top alert" }))
    })

    // Newest card is at index 0; toggle shows +2 more in stack · Expand
    const toggle = screen.getByTestId("live-notification-deck-toggle")
    expect(toggle).toHaveTextContent("+2 more in stack · Expand")

    const renderedCollapsed = screen.getAllByTestId("live-notification-card")
    expect(renderedCollapsed).toHaveLength(3)
    expect(renderedCollapsed[0]).toHaveTextContent("Newest top alert")
    expect(renderedCollapsed[0]).not.toHaveAttribute("aria-hidden")
    expect(renderedCollapsed[1]).toHaveAttribute("aria-hidden", "true")
    expect(renderedCollapsed[2]).toHaveAttribute("aria-hidden", "true")

    // Top card timer runs; stacked background cards are paused so they never silently vanish behind card 0
    const countdowns = screen.getAllByTestId("live-notification-countdown")
    expect(countdowns[0]).toHaveAttribute("data-paused", "false")
    expect(countdowns[1]).toHaveAttribute("data-paused", "true")
    expect(countdowns[2]).toHaveAttribute("data-paused", "true")

    // Expanding shows all cards interactively and switches button to Collapse stack
    fireEvent.click(toggle)
    expect(screen.getByTestId("live-notification-deck-toggle")).toHaveTextContent("Collapse stack")
    const expandedCards = screen.getAllByTestId("live-notification-card")
    expect(expandedCards).toHaveLength(3)

    fireEvent.click(screen.getByTestId("live-notification-deck-toggle"))
    expect(screen.getByTestId("live-notification-deck-toggle")).toHaveTextContent("+2 more in stack · Expand")
  })
})
