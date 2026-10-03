// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

let pathname = "/acme/ws/okrs"
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/lib/actions/auth-actions", () => ({ signOutAction: vi.fn() }))
vi.mock("@/lib/meta-feedback-actions", () => ({ sendCompassFeedback: vi.fn() }))
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn() }) }))

import { NOTIFICATIONS_CHANGED_EVENT, NotificationBellHeaderLink, NotificationBellNavItem } from "@/components/notifications/notification-bell"
import { Sidebar } from "@/components/sidebar"
import { MobileHeader } from "@/components/mobile-header"
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentRailProvider } from "@/components/agent/agent-rail-context"

const fetchMock = vi.fn()
const unread = (count: number, overflow = false) => Promise.resolve({ ok: true, json: async () => ({ available: true, count, overflow }) })
const props = { orgSlug: "acme", workspaceSlug: "ws", initialCount: 3, initialOverflow: false }
const renderNav = (over: Partial<typeof props> = {}) =>
  render(<TooltipProvider><SidebarProvider><SidebarMenu><NotificationBellNavItem {...props} {...over} /></SidebarMenu></SidebarProvider></TooltipProvider>)

beforeEach(() => { pathname = "/acme/ws/okrs"; vi.stubGlobal("fetch", fetchMock); fetchMock.mockReturnValue(unread(3)) })
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe("NotificationBellNavItem", () => {
  it("links to the inbox and shows the server-seeded count without fetching on first paint", () => {
    renderNav()
    expect(screen.getByRole("link", { name: "Notifications, 3 unread" })).toHaveAttribute("href", "/acme/ws/notifications")
    expect(screen.getByTestId("notification-count")).toHaveTextContent("3")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows no badge at zero and 99+ when the count overflows", () => {
    const { unmount } = renderNav({ initialCount: 0 })
    expect(screen.queryByTestId("notification-count")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Notifications" })).toBeInTheDocument()
    unmount()
    renderNav({ initialCount: 99, initialOverflow: true })
    expect(screen.getByTestId("notification-count")).toHaveTextContent("99+")
  })

  it("refetches the bounded count when the tab becomes visible again", async () => {
    fetchMock.mockReturnValue(unread(7))
    renderNav()
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")) })
    await waitFor(() => expect(screen.getByTestId("notification-count")).toHaveTextContent("7"))
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications/unread?orgSlug=acme&workspaceSlug=ws")
  })

  it("refetches when the inbox marks things read", async () => {
    fetchMock.mockReturnValue(unread(0))
    renderNav()
    await act(async () => { window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)) })
    await waitFor(() => expect(screen.queryByTestId("notification-count")).not.toBeInTheDocument())
  })

  it("keeps the last known count when a refetch fails rather than flashing zero", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("offline")))
    renderNav()
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
  const shell = { orgSlug: "acme", workspaceSlug: "ws", workspaceName: "WS", userName: "Rick", userEmail: "r@x.com", workspaces: [{ id: "1", name: "WS", slug: "ws", orgSlug: "acme" }] }

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
