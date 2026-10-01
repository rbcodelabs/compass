// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/acme/ws/notifications" }))

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

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValue({ ok: true, json: async () => ({ marked: 1 }) }) })
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

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

  it("has an unread filter and a link to older notifications", () => {
    view([group()], { nextHref: "/acme/ws/notifications?cursor=abc" })
    expect(screen.getByRole("link", { name: /^Unread/ })).toHaveAttribute("href", "/acme/ws/notifications?filter=unread")
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: "Older notifications" })).toHaveAttribute("href", "/acme/ws/notifications?cursor=abc")
  })
})
