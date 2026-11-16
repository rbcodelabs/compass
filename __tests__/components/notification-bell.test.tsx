// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

let pathname = "/acme/ws/okrs"
const routerPush = vi.fn()
const openPanel = vi.fn()
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: routerPush }) }))
vi.mock("@/lib/actions/auth-actions", () => ({ signOutAction: vi.fn() }))
vi.mock("@/lib/meta-feedback-actions", () => ({ sendCompassFeedback: vi.fn() }))
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel }) }))

import { NOTIFICATIONS_CHANGED_EVENT, NotificationBellHeaderLink, NotificationBellIconButton } from "@/components/notifications/notification-bell"
import { LiveNotificationCardHost } from "@/components/notifications/live-notification-card-host"
import { POLL_INTERVAL_MS, resetLiveNotificationStoresForTests } from "@/lib/notifications-live-client"
import { resetLiveNotificationCards } from "@/lib/ui/live-notification-cards"
import { Sidebar } from "@/components/sidebar"
import { MobileHeader } from "@/components/mobile-header"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentRailProvider } from "@/components/agent/agent-rail-context"

const fetchMock = vi.fn()
const unread = (count: number, overflow = false) => Promise.resolve({ ok: true, json: async () => ({ available: true, count, overflow }) })
const props = { orgSlug: "acme", workspaceSlug: "ws", initialCount: 3, initialOverflow: false }
const renderIcon = (over: Partial<typeof props> = {}) =>
  render(<TooltipProvider><SidebarProvider><NotificationBellIconButton {...props} {...over} /></SidebarProvider></TooltipProvider>)

beforeEach(() => {
  pathname = "/acme/ws/okrs"
  routerPush.mockReset()
  openPanel.mockReset()
  resetLiveNotificationStoresForTests()
  resetLiveNotificationCards()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReturnValue(unread(3))
})
afterEach(() => {
  cleanup()
  resetLiveNotificationStoresForTests()
  resetLiveNotificationCards()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("NotificationBellIconButton (beside Search)", () => {
  it("links to the inbox with the unread count in its accessible name and a badge, without fetching on first paint", () => {
    renderIcon()
    expect(screen.getByRole("link", { name: "Notifications, 3 unread" })).toHaveAttribute("href", "/acme/ws/notifications")
    expect(screen.getByTestId("notification-count")).toHaveTextContent("3")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("has a plain label and no badge or dot at zero", () => {
    renderIcon({ initialCount: 0 })
    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/acme/ws/notifications")
    expect(screen.queryByTestId("notification-count")).not.toBeInTheDocument()
    expect(screen.queryByTestId("notification-dot")).not.toBeInTheDocument()
  })

  it("caps the badge at 99+ on overflow and keeps a dot for the collapsed rail", () => {
    renderIcon({ initialCount: 99, initialOverflow: true })
    expect(screen.getByTestId("notification-count")).toHaveTextContent("99+")
    expect(screen.getByTestId("notification-dot")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Notifications, 99\+ unread/ })).toBeInTheDocument()
  })

  it("is marked active only on the inbox route", () => {
    const { unmount } = renderIcon()
    expect(screen.getByRole("link", { name: /Notifications/ })).not.toHaveAttribute("data-active")
    unmount()
    pathname = "/acme/ws/notifications"
    renderIcon()
    expect(screen.getByRole("link", { name: /Notifications/ })).toHaveAttribute("data-active")
  })

  it("refetches the bounded count when the tab becomes visible again", async () => {
    fetchMock.mockReturnValue(unread(7))
    renderIcon()
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")) })
    await waitFor(() => expect(screen.getByTestId("notification-count")).toHaveTextContent("7"))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/notifications\/unread\?orgSlug=acme&workspaceSlug=ws&since=/))
  })

  it("polls every 20s, updates the badge, and surfaces a top-right live card that opens the detail panel in place", async () => {
    vi.useFakeTimers()
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/notifications/read") return { ok: true, json: async () => ({ marked: 1 }) }
      return {
        ok: true,
        json: async () => ({
          available: true,
          count: 4,
          overflow: false,
          serverNow: "2026-11-15T12:00:20.000Z",
          alerts: [
            {
              id: "live-1",
              kind: "ASSIGNED",
              subjectType: "TASK",
              subjectId: "t-99",
              subjectLabel: "Task",
              displayId: "TASK-99",
              title: "Review release plan",
              path: "tasks/t-99",
              priority: "HIGH",
              status: "TODO",
              actorType: "USER",
              actorName: "Ada",
              action: "assigned this to you",
              sentence: "Ada assigned this to you",
              commentSnippet: null,
              createdAt: "2026-11-15T12:00:10.000Z",
            },
          ],
        }),
      }
    })

    render(
      <TooltipProvider>
        <SidebarProvider>
          <NotificationBellIconButton {...props} initialCount={0} />
          <LiveNotificationCardHost orgSlug="acme" workspaceSlug="ws" />
        </SidebarProvider>
      </TooltipProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    expect(screen.getByTestId("notification-count")).toHaveTextContent("4")
    const card = screen.getByTestId("live-notification-card")
    expect(card).toHaveTextContent("TASK-99")
    expect(card).toHaveTextContent("Review release plan")

    await act(async () => {
      screen.getByTestId("live-notification-open").click()
      await Promise.resolve()
    })
    expect(openPanel).toHaveBeenCalledWith("task", "t-99")
  })

  it("deduplicates polling and state across desktop and mobile bells mounted in the same workspace", async () => {
    vi.useFakeTimers()
    fetchMock.mockReturnValue(unread(9))

    render(
      <TooltipProvider>
        <SidebarProvider>
          <NotificationBellIconButton {...props} initialCount={1} />
          <NotificationBellHeaderLink {...props} initialCount={1} />
        </SidebarProvider>
      </TooltipProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const badges = screen.getAllByTestId("notification-count")
    expect(badges).toHaveLength(2)
    expect(badges[0]).toHaveTextContent("9")
    expect(badges[1]).toHaveTextContent("9")
  })

  it("refetches when the inbox marks things read", async () => {
    fetchMock.mockReturnValue(unread(0))
    renderIcon()
    await act(async () => { window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)) })
    await waitFor(() => expect(screen.queryByTestId("notification-count")).not.toBeInTheDocument())
  })

  it("keeps the last known count when a refetch fails rather than flashing zero", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("offline")))
    renderIcon()
    await act(async () => { window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)) })
    expect(screen.getByTestId("notification-count")).toHaveTextContent("3")
  })
})

describe("NotificationBellHeaderLink (mobile)", () => {
  it("renders an Inbox link with the count", () => {
    render(<NotificationBellHeaderLink {...props} />)
    expect(screen.getByRole("link", { name: "Notifications, 3 unread" })).toHaveAttribute("href", "/acme/ws/notifications")
    expect(screen.getByTestId("notification-count")).toHaveTextContent("3")
  })
})

describe("shell wiring", () => {
  const shell = { orgSlug: "acme", workspaceSlug: "ws", workspaceName: "WS", userName: "Rick", userEmail: "r@x.com", workspaces: [{ id: "1", name: "WS", slug: "ws", orgSlug: "acme", orgName: "Acme" }] }

  it("shows the bell in the sidebar only when following is enabled", () => {
    const renderSidebar = (followingEnabled: boolean) => render(<TooltipProvider><SidebarProvider><AgentRailProvider initialPin={{ pinned: false, width: 0 } as never}><Sidebar {...shell} followingEnabled={followingEnabled} unreadNotifications={{ count: 2, overflow: false }} /></AgentRailProvider></SidebarProvider></TooltipProvider>)
    const first = renderSidebar(false)
    expect(screen.queryByRole("link", { name: /^Notifications/ })).not.toBeInTheDocument()
    first.unmount()
    renderSidebar(true)
    expect(screen.getByRole("link", { name: "Notifications, 2 unread" })).toBeInTheDocument()
  })

  it("shows the bell in the mobile header only when following is enabled", () => {
    const first = render(<MobileHeader {...shell} />)
    expect(screen.queryByRole("link", { name: /^Notifications/ })).not.toBeInTheDocument()
    first.unmount()
    render(<MobileHeader {...shell} followingEnabled unreadNotifications={{ count: 5, overflow: false }} />)
    expect(screen.getByRole("link", { name: "Notifications, 5 unread" })).toBeInTheDocument()
  })
})
