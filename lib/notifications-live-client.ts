"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { isDesktopNotificationsActive } from "@/lib/desktop-notifications-pref"
import type { LiveNotificationAlert } from "@/lib/notifications"
import {
  clearLiveNotificationCards,
  dismissLiveNotificationCard,
  pushLiveNotificationCard,
} from "@/lib/ui/live-notification-cards"

/** Dispatched after notifications are marked read so the bell updates immediately. */
export const NOTIFICATIONS_CHANGED_EVENT = "compass:notifications-changed"

export const POLL_INTERVAL_MS = 20_000
const MIN_POLL_GAP_MS = 18_000
export const SEEN_ALERTS_STORAGE_KEY = "compass:notified-alert-ids"
const MAX_SEEN_ALERT_IDS = 100

export type UnreadSnapshot = {
  count: number
  overflow: boolean
}

type UnreadApiPayload = {
  available?: boolean
  count?: number
  overflow?: boolean
  serverNow?: string
  alerts?: LiveNotificationAlert[]
}

type BroadcastMessage =
  | { type: "hello"; tabId: string; focused: boolean }
  | { type: "focus"; tabId: string; focused: boolean }
  | { type: "bye"; tabId: string }
  | { type: "alerted"; tabId: string; ids: string[] }
  | { type: "dismissed"; tabId: string; id: string }
  | {
      type: "sync"
      tabId: string
      count: number
      overflow: boolean
      cursor: string
      alerts: LiveNotificationAlert[]
    }

function randomTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

export function defaultIsTabFocused(): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    (typeof document.hasFocus !== "function" || document.hasFocus())
  )
}

function readStoredSeenIds(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(SEEN_ALERTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string").slice(-MAX_SEEN_ALERT_IDS)
  } catch {
    return []
  }
}

function persistSeenIds(ids: string[]): void {
  if (typeof window === "undefined") return
  try {
    const current = readStoredSeenIds()
    const merged = [...current]
    const set = new Set(current)
    for (const id of ids) {
      if (!set.has(id)) {
        set.add(id)
        merged.push(id)
      }
    }
    const bounded = merged.slice(-MAX_SEEN_ALERT_IDS)
    window.localStorage.setItem(SEEN_ALERTS_STORAGE_KEY, JSON.stringify(bounded))
  } catch {
    // Restricted storage environment; in-memory deduplication still holds.
  }
}

export type WorkspaceLiveStoreOptions = {
  orgSlug: string
  workspaceSlug: string
  initial: UnreadSnapshot
  initialPathname?: string
  navigate?: (href: string) => void
  isFocused?: () => boolean
}

export type WorkspaceLiveStore = {
  getState: () => UnreadSnapshot
  subscribe: (listener: () => void) => () => void
  subscriberCount: () => number
  setNavigate: (navigate: ((href: string) => void) | undefined) => void
  notifyPathname: (pathname: string) => void
  broadcastDismissed: (id: string) => void
  refetch: (reason?: "poll" | "navigation" | "visibility" | "changed") => Promise<void>
  destroy: () => void
}

const workspaceStores = new Map<string, WorkspaceLiveStore>()

function storeKey(orgSlug: string, workspaceSlug: string): string {
  return `${orgSlug}/${workspaceSlug}`
}

/**
 * Marks a live notification read on the server, immediately dismisses its card
 * locally and across sibling tabs, and dispatches NOTIFICATIONS_CHANGED_EVENT
 * so both desktop and mobile bell badges decrement immediately.
 */
export async function markLiveNotificationRead(
  orgSlug: string,
  workspaceSlug: string,
  id: string,
): Promise<boolean> {
  dismissLiveNotificationCard(id)
  workspaceStores.get(storeKey(orgSlug, workspaceSlug))?.broadcastDismissed(id)
  try {
    const response = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        workspaceSlug,
        ids: [id],
      }),
      keepalive: true,
    })
    if (response.ok && typeof window !== "undefined") {
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT))
    }
    return response.ok
  } catch {
    return false
  }
}

export function createWorkspaceLiveStore(options: WorkspaceLiveStoreOptions): WorkspaceLiveStore {
  const { orgSlug, workspaceSlug } = options
  const isFocused = options.isFocused ?? defaultIsTabFocused
  const tabId = randomTabId()

  let state: UnreadSnapshot = {
    count: options.initial.count,
    overflow: options.initial.overflow,
  }
  let cursor = new Date().toISOString()
  let lastSyncedAt = Date.now()
  let lastPathname: string | null = options.initialPathname ?? null
  let navigateFn: ((href: string) => void) | undefined = options.navigate
  let latestReqId = 0
  let destroyed = false

  const subscribers = new Set<() => void>()
  const focusedSiblingTabs = new Set<string>()
  const seenAlertIds = new Set<string>(readStoredSeenIds())

  let channel: BroadcastChannel | null = null

  function emit() {
    for (const listener of subscribers) listener()
  }

  function postBroadcast(msg: BroadcastMessage) {
    if (!channel) return
    try {
      channel.postMessage(msg)
    } catch {
      // Channel may already be closed during teardown.
    }
  }

  function hasSeenAlert(id: string): boolean {
    if (seenAlertIds.has(id)) return true
    for (const stored of readStoredSeenIds()) {
      seenAlertIds.add(stored)
    }
    return seenAlertIds.has(id)
  }

  function markAlertsSeen(ids: string[]) {
    if (ids.length === 0) return
    for (const id of ids) seenAlertIds.add(id)
    persistSeenIds(ids)
    postBroadcast({ type: "alerted", tabId, ids })
  }

  function isOnNotificationsPage(): boolean {
    if (!lastPathname) return false
    return lastPathname.startsWith(`/${orgSlug}/${workspaceSlug}/notifications`)
  }

  async function openAlertFromDesktopNotification(alert: LiveNotificationAlert) {
    await markLiveNotificationRead(orgSlug, workspaceSlug, alert.id)
    const cleanPath = alert.path.replace(/^\/+/, "")
    const href = `/${orgSlug}/${workspaceSlug}/${cleanPath}`
    navigateFn?.(href)
  }

  function surfaceFocusedCard(alert: LiveNotificationAlert) {
    markAlertsSeen([alert.id])
    if (isOnNotificationsPage()) return
    pushLiveNotificationCard({
      ...alert,
      orgSlug,
      workspaceSlug,
    })
  }

  function surfaceBackgroundDesktopNotification(alert: LiveNotificationAlert) {
    markAlertsSeen([alert.id])
    if (!isDesktopNotificationsActive()) return
    if (typeof window === "undefined" || !("Notification" in window) || !window.Notification) return
    try {
      const prefix = alert.displayId ?? alert.subjectLabel
      const notification = new window.Notification(`${prefix}: ${alert.title}`, {
        body: alert.sentence,
        tag: `compass-notif-${alert.id}`,
      })
      notification.onclick = () => {
        if (typeof window.focus === "function") window.focus()
        notification.close()
        void openAlertFromDesktopNotification(alert)
      }
    } catch {
      // Ignore environments where constructing Notification directly is disallowed.
    }
  }

  async function refetch(reason: "poll" | "navigation" | "visibility" | "changed" = "changed") {
    if (destroyed) return
    if (reason === "poll" && Date.now() - lastSyncedAt < MIN_POLL_GAP_MS) {
      return
    }
    const mine = ++latestReqId
    const sinceParam = cursor
    const url = `/api/notifications/unread?orgSlug=${encodeURIComponent(orgSlug)}&workspaceSlug=${encodeURIComponent(workspaceSlug)}&since=${encodeURIComponent(sinceParam)}`

    try {
      const response = await fetch(url)
      if (!response.ok || destroyed) return
      const data = (await response.json()) as UnreadApiPayload | null
      if (!data?.available || destroyed) return

      lastSyncedAt = Date.now()
      const nextCursor =
        typeof data.serverNow === "string" && data.serverNow.length > 0
          ? data.serverNow
          : new Date().toISOString()

      if (mine === latestReqId) {
        cursor = nextCursor
        const nextCount = data.count ?? 0
        const nextOverflow = Boolean(data.overflow)
        if (state.count !== nextCount || state.overflow !== nextOverflow) {
          state = { count: nextCount, overflow: nextOverflow }
          emit()
        }
        if (nextCount === 0) {
          clearLiveNotificationCards({ orgSlug, workspaceSlug })
        }
      } else if (nextCursor > cursor) {
        cursor = nextCursor
      }

      const incoming = Array.isArray(data.alerts) ? data.alerts : []
      const unseen = incoming.filter(
        (item): item is LiveNotificationAlert => Boolean(item && typeof item.id === "string" && !hasSeenAlert(item.id)),
      )

      if (isFocused()) {
        for (const alert of unseen) {
          surfaceFocusedCard(alert)
        }
        postBroadcast({
          type: "sync",
          tabId,
          count: state.count,
          overflow: state.overflow,
          cursor,
          alerts: [],
        })
      } else if (focusedSiblingTabs.size > 0) {
        // Delegate card surfacing to the focused sibling tab without firing an OS notification.
        postBroadcast({
          type: "sync",
          tabId,
          count: state.count,
          overflow: state.overflow,
          cursor,
          alerts: unseen,
        })
      } else {
        for (const alert of unseen) {
          surfaceBackgroundDesktopNotification(alert)
        }
        postBroadcast({
          type: "sync",
          tabId,
          count: state.count,
          overflow: state.overflow,
          cursor,
          alerts: [],
        })
      }
    } catch {
      // A failed refetch keeps the last known count rather than flashing zero.
    }
  }

  function broadcastFocusState() {
    postBroadcast({ type: "focus", tabId, focused: isFocused() })
  }

  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(`compass:notifications:${orgSlug}:${workspaceSlug}`)
      channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
        if (destroyed) return
        const msg = event.data
        if (!msg || typeof msg !== "object" || msg.tabId === tabId) return

        switch (msg.type) {
          case "hello": {
            if (msg.focused) focusedSiblingTabs.add(msg.tabId)
            else focusedSiblingTabs.delete(msg.tabId)
            broadcastFocusState()
            break
          }
          case "focus": {
            if (msg.focused) focusedSiblingTabs.add(msg.tabId)
            else focusedSiblingTabs.delete(msg.tabId)
            break
          }
          case "bye": {
            focusedSiblingTabs.delete(msg.tabId)
            break
          }
          case "alerted": {
            if (Array.isArray(msg.ids)) {
              for (const id of msg.ids) seenAlertIds.add(id)
            }
            break
          }
          case "dismissed": {
            if (typeof msg.id === "string") {
              dismissLiveNotificationCard(msg.id)
            }
            break
          }
          case "sync": {
            lastSyncedAt = Date.now()
            if (typeof msg.cursor === "string" && msg.cursor > cursor) {
              cursor = msg.cursor
            }
            if (state.count !== msg.count || state.overflow !== msg.overflow) {
              state = { count: msg.count, overflow: msg.overflow }
              emit()
            }
            if (msg.count === 0) {
              clearLiveNotificationCards({ orgSlug, workspaceSlug })
            }
            if (isFocused() && Array.isArray(msg.alerts) && msg.alerts.length > 0) {
              for (const alert of msg.alerts) {
                if (alert && typeof alert.id === "string" && !hasSeenAlert(alert.id)) {
                  surfaceFocusedCard(alert)
                }
              }
            }
            break
          }
        }
      }
      postBroadcast({ type: "hello", tabId, focused: isFocused() })
    } catch {
      channel = null
    }
  }

  const onVisibilityChange = () => {
    broadcastFocusState()
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void refetch("visibility")
    }
  }
  const onNotificationsChanged = () => {
    void refetch("changed")
  }
  const onFocusOrBlur = () => {
    broadcastFocusState()
  }
  const onPageHide = () => {
    postBroadcast({ type: "bye", tabId })
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange)
  }
  if (typeof window !== "undefined") {
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onNotificationsChanged)
    window.addEventListener("focus", onFocusOrBlur)
    window.addEventListener("blur", onFocusOrBlur)
    window.addEventListener("pagehide", onPageHide)
  }

  const intervalId =
    typeof window !== "undefined"
      ? window.setInterval(() => {
          void refetch("poll")
        }, POLL_INTERVAL_MS)
      : null

  function destroy() {
    if (destroyed) return
    destroyed = true
    if (intervalId !== null && typeof window !== "undefined") {
      window.clearInterval(intervalId)
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
    if (typeof window !== "undefined") {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onNotificationsChanged)
      window.removeEventListener("focus", onFocusOrBlur)
      window.removeEventListener("blur", onFocusOrBlur)
      window.removeEventListener("pagehide", onPageHide)
    }
    if (channel) {
      postBroadcast({ type: "bye", tabId })
      try {
        channel.close()
      } catch {
        // Ignore close errors.
      }
      channel = null
    }
    subscribers.clear()
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    subscriberCount: () => subscribers.size,
    setNavigate(nextNavigate) {
      navigateFn = nextNavigate
    },
    notifyPathname(pathname: string) {
      if (lastPathname === null) {
        lastPathname = pathname
        return
      }
      if (pathname === lastPathname) return
      lastPathname = pathname
      if (isOnNotificationsPage()) {
        clearLiveNotificationCards({ orgSlug, workspaceSlug })
      }
      void refetch("navigation")
    },
    broadcastDismissed(id: string) {
      postBroadcast({ type: "dismissed", tabId, id })
    },
    refetch,
    destroy,
  }
}

/** Test helper: tear down any active stores and clear seen-alert storage. */
export function resetLiveNotificationStoresForTests(): void {
  for (const store of workspaceStores.values()) {
    store.destroy()
  }
  workspaceStores.clear()
  clearLiveNotificationCards()
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(SEEN_ALERTS_STORAGE_KEY)
    } catch {
      // Ignore storage cleanup failure.
    }
  }
}

/**
 * Shared live unread-count and personal-alert subscription for one workspace.
 * Multiple bells mounted simultaneously in the same tab (desktop Sidebar +
 * MobileHeader) share a single store, timer, and fetch stream, and tear down
 * cleanly when the last bell unmounts.
 */
export function useLiveUnread(
  orgSlug: string,
  workspaceSlug: string,
  initial: UnreadSnapshot,
  pathname: string,
  navigate: (href: string) => void,
): UnreadSnapshot {
  const key = storeKey(orgSlug, workspaceSlug)
  const fallback = useMemo<UnreadSnapshot>(
    () => ({ count: initial.count, overflow: initial.overflow }),
    [initial.count, initial.overflow],
  )

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let store = workspaceStores.get(key)
      if (!store) {
        store = createWorkspaceLiveStore({
          orgSlug,
          workspaceSlug,
          initial: fallback,
          initialPathname: pathname,
          navigate,
        })
        workspaceStores.set(key, store)
      } else {
        store.setNavigate(navigate)
      }

      const unsubscribe = store.subscribe(onStoreChange)
      return () => {
        unsubscribe()
        const current = workspaceStores.get(key)
        if (current && current.subscriberCount() === 0) {
          current.destroy()
          workspaceStores.delete(key)
        }
      }
    },
    // Initial `fallback`, `pathname`, and `navigate` seed store creation once; subsequent updates flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, orgSlug, workspaceSlug],
  )

  const getSnapshot = useCallback(
    () => workspaceStores.get(key)?.getState() ?? fallback,
    [key, fallback],
  )
  const getServerSnapshot = useCallback(() => fallback, [fallback])

  const unread = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    workspaceStores.get(key)?.setNavigate(navigate)
  }, [key, navigate])

  useEffect(() => {
    workspaceStores.get(key)?.notifyPathname(pathname)
  }, [key, pathname])

  return unread
}
