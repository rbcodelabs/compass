// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { setDesktopNotificationsEnabled } from "@/lib/desktop-notifications-pref"
import type { LiveNotificationAlert } from "@/lib/notifications"
import {
  POLL_INTERVAL_MS,
  createWorkspaceLiveStore,
  markLiveNotificationRead,
  resetLiveNotificationStoresForTests,
  useLiveUnread,
} from "@/lib/notifications-live-client"
import { getLiveNotificationCards, resetLiveNotificationCards } from "@/lib/ui/live-notification-cards"

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()
  readonly name: string
  onmessage: ((event: MessageEvent) => void) | null = null
  private closed = false

  constructor(name: string) {
    this.name = name
    let peers = FakeBroadcastChannel.channels.get(name)
    if (!peers) {
      peers = new Set()
      FakeBroadcastChannel.channels.set(name, peers)
    }
    peers.add(this)
  }

  postMessage(data: unknown) {
    if (this.closed) return
    const peers = FakeBroadcastChannel.channels.get(this.name)
    if (!peers) return
    for (const peer of peers) {
      if (peer !== this && !peer.closed && peer.onmessage) {
        peer.onmessage(new MessageEvent("message", { data }))
      }
    }
  }

  close() {
    this.closed = true
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }

  static reset() {
    FakeBroadcastChannel.channels.clear()
  }
}

const sampleAlert = (overrides: Partial<LiveNotificationAlert> = {}): LiveNotificationAlert => ({
  id: "alert-1",
  kind: "ASSIGNED",
  subjectType: "TASK",
  subjectId: "task-123",
  subjectLabel: "Task",
  displayId: "TASK-123",
  title: "Fix flaky sync",
  path: "tasks/task-123",
  priority: "HIGH",
  status: "TODO",
  actorType: "USER",
  actorName: "Ada",
  action: "assigned this to you",
  sentence: "Ada assigned this to you",
  commentSnippet: null,
  createdAt: "2026-11-15T12:00:05.000Z",
  ...overrides,
})

const fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  resetLiveNotificationCards()
  resetLiveNotificationStoresForTests()
  FakeBroadcastChannel.reset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel)
})

afterEach(() => {
  cleanup()
  resetLiveNotificationStoresForTests()
  resetLiveNotificationCards()
  FakeBroadcastChannel.reset()
  window.localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("notifications-live-client", () => {
  it("does not fetch on initial mount, polls every 20s, and deduplicates two bells in the same workspace", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        available: true,
        count: 5,
        overflow: false,
        serverNow: "2026-11-15T12:00:20.000Z",
        alerts: [],
      }),
    })

    const navigate = vi.fn()
    const bellA = renderHook(({ path }) => useLiveUnread("acme", "ws", { count: 2, overflow: false }, path, navigate), {
      initialProps: { path: "/acme/ws/okrs" },
    })
    const bellB = renderHook(({ path }) => useLiveUnread("acme", "ws", { count: 2, overflow: false }, path, navigate), {
      initialProps: { path: "/acme/ws/okrs" },
    })

    expect(bellA.result.current).toEqual({ count: 2, overflow: false })
    expect(bellB.result.current).toEqual({ count: 2, overflow: false })
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bellA.result.current).toEqual({ count: 5, overflow: false })
    expect(bellB.result.current).toEqual({ count: 5, overflow: false })

    // Navigating both bells to the same next route triggers only one fetch
    bellA.rerender({ path: "/acme/ws/tasks" })
    bellB.rerender({ path: "/acme/ws/tasks" })
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("surfaces a live notification card on a focused tab, deduplicates seen IDs, and marks read cleanly", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    const alert = sampleAlert()
    let unreadRemaining = 1
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("/api/notifications/read")) {
        unreadRemaining = 0
        return { ok: true, json: async () => ({ marked: 1 }) }
      }
      return {
        ok: true,
        json: async () => ({
          available: true,
          count: unreadRemaining,
          overflow: false,
          serverNow: "2026-11-15T12:00:20.000Z",
          alerts: unreadRemaining > 0 ? [alert] : [],
        }),
      }
    })

    const navigate = vi.fn()
    const bell = renderHook(() => useLiveUnread("acme", "ws", { count: 0, overflow: false }, "/acme/ws/okrs", navigate))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    const cards = getLiveNotificationCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: "alert-1",
      displayId: "TASK-123",
      title: "Fix flaky sync",
      orgSlug: "acme",
      workspaceSlug: "ws",
    })
    expect(bell.result.current).toEqual({ count: 1, overflow: false })

    // Second poll returning the same alert within the 2s overlap window does not duplicate
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(getLiveNotificationCards()).toHaveLength(1)

    // Marking the live card read removes the card and refreshes the bell count back to 0
    await act(async () => {
      await markLiveNotificationRead("acme", "ws", "alert-1")
    })

    expect(getLiveNotificationCards()).toHaveLength(0)
    expect(bell.result.current).toEqual({ count: 0, overflow: false })
  })

  it("fires window.Notification when unfocused with no focused sibling tabs and desktop alerts enabled", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const created: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }> = []
    class MockNotification {
      static permission: NotificationPermission = "granted"
      onclick: (() => void) | null = null
      close = vi.fn()
      constructor(title: string, options?: NotificationOptions) {
        created.push({ title, options, onclick: null, close: this.close })
        const entry = created[created.length - 1]
        Object.defineProperty(this, "onclick", {
          get: () => entry.onclick,
          set: (fn) => {
            entry.onclick = fn
          },
        })
      }
    }
    vi.stubGlobal("Notification", MockNotification)
    setDesktopNotificationsEnabled(true)

    const alert = sampleAlert({ id: "bg-alert-1" })
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/notifications/read")) {
        return { ok: true, json: async () => ({ marked: 1 }) }
      }
      return {
        ok: true,
        json: async () => ({
          available: true,
          count: 1,
          overflow: false,
          serverNow: "2026-11-15T12:00:20.000Z",
          alerts: [alert],
        }),
      }
    })

    const navigate = vi.fn()
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {})
    renderHook(() => useLiveUnread("acme", "ws", { count: 0, overflow: false }, "/acme/ws/okrs", navigate))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    expect(getLiveNotificationCards()).toHaveLength(0)
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe("TASK-123: Fix flaky sync")
    expect(created[0].options).toEqual({
      body: "Ada assigned this to you",
      tag: "compass-notif-bg-alert-1",
    })

    await act(async () => {
      created[0].onclick?.()
      await Promise.resolve()
    })
    expect(focusSpy).toHaveBeenCalled()
    expect(created[0].close).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith("/acme/ws/tasks/task-123")
  })

  it("coordinates across tabs via BroadcastChannel: unfocused polling tab suppresses OS alert while focused sibling tab pushes card", async () => {
    const createdOsNotifications: string[] = []
    class MockNotification {
      static permission: NotificationPermission = "granted"
      constructor(title: string) {
        createdOsNotifications.push(title)
      }
    }
    vi.stubGlobal("Notification", MockNotification)
    setDesktopNotificationsEnabled(true)

    const alert = sampleAlert({ id: "cross-tab-1" })
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        available: true,
        count: 4,
        overflow: false,
        serverNow: "2026-11-15T12:00:20.000Z",
        alerts: [alert],
      }),
    })

    const tabBackground = createWorkspaceLiveStore({
      orgSlug: "acme",
      workspaceSlug: "ws",
      initial: { count: 0, overflow: false },
      initialPathname: "/acme/ws/tasks",
      isFocused: () => false,
    })
    const tabFocused = createWorkspaceLiveStore({
      orgSlug: "acme",
      workspaceSlug: "ws",
      initial: { count: 0, overflow: false },
      initialPathname: "/acme/ws/okrs",
      isFocused: () => true,
    })

    try {
      await tabBackground.refetch("changed")

      // Both tabs share the updated unread count
      expect(tabBackground.getState()).toEqual({ count: 4, overflow: false })
      expect(tabFocused.getState()).toEqual({ count: 4, overflow: false })

      // OS notification was suppressed because tabFocused is active, and tabFocused pushed the live card
      expect(createdOsNotifications).toHaveLength(0)
      expect(getLiveNotificationCards()).toHaveLength(1)
      expect(getLiveNotificationCards()[0].title).toBe("Fix flaky sync")
    } finally {
      tabBackground.destroy()
      tabFocused.destroy()
    }
  })
})
