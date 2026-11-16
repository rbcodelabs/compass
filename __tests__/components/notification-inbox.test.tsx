// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/acme/ws/notifications" }))

import { ThinkingModelProvider } from "@/components/thinking-model/thinking-model-provider"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { NotificationInbox } from "@/components/notifications/notification-inbox"
import type { InboxGroup } from "@/lib/notification-inbox"

const fetchMock = vi.fn()
const group = (over: Partial<InboxGroup> = {}): InboxGroup => ({
  key: "TASK:t1", subjectType: "TASK", subjectLabel: "Task", title: "Ship it", href: "/acme/ws/tasks/t1", unreadCount: 2, latestAt: "2026-10-01T10:00:00.000Z",
  items: [
    { id: "n2", actorName: "Ada", action: "commented", sentence: "Ada commented", read: false, createdAt: "2026-10-01T10:00:00.000Z" },
    { id: "n1", actorName: "Bo", action: "changed status from Todo to Done", sentence: "Bo changed status from Todo to Done", read: false, createdAt: "2026-10-01T09:00:00.000Z" },
  ],
  ...over,
})
const view = (groups: InboxGroup[], over: Partial<React.ComponentProps<typeof NotificationInbox>> = {}) =>
  render(<NotificationInbox orgSlug="acme" workspaceSlug="ws" groups={groups} unreadOnly={false} nextHref={null} totalUnread={2} {...over} />)

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ marked: 1 }) })
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("NotificationInbox", () => {
  it("groups by item with a link, the new count and each plain-language sentence", () => {
    view([group()])
    expect(screen.getByRole("link", { name: "Ship it" })).toHaveAttribute("href", "/acme/ws/tasks/t1")
    expect(screen.getByText("2 new")).toBeInTheDocument()
    expect(screen.getByText("Ada commented")).toBeInTheDocument()
    expect(screen.getByText("Bo changed status from Todo to Done")).toBeInTheDocument()
  })

  it("marks a group's unread rows read when its link is followed", async () => {
    view([group()])
    fireEvent.click(screen.getByRole("link", { name: "Ship it" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/notifications/read")
    expect(JSON.parse(init.body)).toEqual({ orgSlug: "acme", workspaceSlug: "ws", ids: ["n2", "n1"] })
    expect(screen.queryByText("2 new")).not.toBeInTheDocument()
  })

  it("Mark all read posts all:true and refreshes the page data", async () => {
    view([group()])
    fireEvent.click(screen.getByRole("button", { name: /Mark all read/ }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ orgSlug: "acme", workspaceSlug: "ws", all: true })
  })

  it("says so when marking read fails, and does not pretend it worked", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
    view([group()])
    fireEvent.click(screen.getByRole("button", { name: /Mark all read/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark notifications read")
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByText("2 new")).toBeInTheDocument()
  })

  it("renders a deleted or inaccessible subject without a title or link", () => {
    view([group({ title: null, href: null })])
    expect(screen.getByText("No longer available")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Ship it" })).not.toBeInTheDocument()
    expect(screen.getByText("Ada commented")).toBeInTheDocument()
  })

  it("shows an empty state that explains how notifications arrive", () => {
    view([], { totalUnread: 0 })
    expect(screen.getByText("No notifications yet.")).toBeInTheDocument()
    expect(screen.getByText(/You follow what you create, comment on or are assigned/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Mark all read/ })).toBeDisabled()
  })

  it("uses the workspace's thinking-model names for Opportunity and Solution", () => {
    const labels = JSON.stringify({ opportunity: { singular: "Bet", plural: "Bets" }, solution: { singular: "Approach", plural: "Approaches" } })
    render(
      <ThinkingModelProvider value={resolveThinkingModel({ thinkingModel: "CLASSIC", thinkingModelLabels: labels })}>
        <NotificationInbox orgSlug="acme" workspaceSlug="ws" groups={[group({ subjectType: "OPPORTUNITY", subjectLabel: "Opportunity" })]} unreadOnly={false} nextHref={null} totalUnread={2} />
      </ThinkingModelProvider>,
    )
    expect(screen.getByText("Bet")).toBeInTheDocument()
    expect(screen.queryByText("Opportunity")).not.toBeInTheDocument()
    expect(screen.getByText(/on the bets, approaches, tasks and docs you follow/)).toBeInTheDocument()
  })

  it("has an unread filter and a link to older notifications", () => {
    view([group()], { nextHref: "/acme/ws/notifications?cursor=abc" })
    expect(screen.getByRole("link", { name: /^Unread/ })).toHaveAttribute("href", "/acme/ws/notifications?filter=unread")
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: "Older notifications" })).toHaveAttribute("href", "/acme/ws/notifications?cursor=abc")
  })

  it("omits the desktop alerts toggle when browser Notification API is unsupported", () => {
    const original = (window as unknown as Record<string, unknown>).Notification
    delete (window as unknown as Record<string, unknown>).Notification
    try {
      view([group()])
      expect(screen.queryByTestId("desktop-notifications-toggle")).not.toBeInTheDocument()
    } finally {
      if (original !== undefined) {
        ;(window as unknown as Record<string, unknown>).Notification = original
      }
    }
  })

  it("renders a disabled blocked button when browser notification permission is denied", () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() })
    view([group()])
    const btn = screen.getByTestId("desktop-notifications-toggle")
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent("Desktop alerts blocked")
  })

  it("requests permission and toggles Desktop alerts Off -> On -> Off", async () => {
    let perm: NotificationPermission = "default"
    const requestPermission = vi.fn(async () => {
      perm = "granted"
      return perm
    })
    vi.stubGlobal("Notification", {
      get permission() {
        return perm
      },
      requestPermission,
    })

    view([group()])
    const btn = screen.getByTestId("desktop-notifications-toggle")
    expect(btn).toHaveTextContent("Desktop alerts: Off")
    expect(btn).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveTextContent("Desktop alerts: On"))
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(btn).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveTextContent("Desktop alerts: Off"))
    expect(btn).toHaveAttribute("aria-pressed", "false")
  })
})
