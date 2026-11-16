// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DESKTOP_NOTIFICATIONS_STORAGE_KEY,
  getDesktopNotificationServerSnapshot,
  getDesktopNotificationSnapshot,
  isDesktopNotificationsActive,
  setDesktopNotificationsEnabled,
  subscribeDesktopNotificationPref,
  toggleDesktopNotificationsFromGesture,
} from "@/lib/desktop-notifications-pref"

function stubNotification(initialPermission: NotificationPermission, nextOnRequest?: NotificationPermission) {
  let perm = initialPermission
  const requestPermission = vi.fn(async () => {
    if (nextOnRequest) perm = nextOnRequest
    return perm
  })
  class MockNotification {
    static get permission() {
      return perm
    }
    static requestPermission = requestPermission
  }
  vi.stubGlobal("Notification", MockNotification)
  return { requestPermission, setPermission: (p: NotificationPermission) => { perm = p } }
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("desktop-notifications-pref", () => {
  it("returns stable unsupported server snapshot and unsupported client state when Notification API is absent", async () => {
    // Delete Notification if present in jsdom
    const original = (window as unknown as Record<string, unknown>).Notification
    delete (window as unknown as Record<string, unknown>).Notification
    try {
      const serverSnap = getDesktopNotificationServerSnapshot()
      expect(serverSnap).toEqual({ permission: "unsupported", enabled: false })
      expect(getDesktopNotificationServerSnapshot()).toBe(serverSnap)

      const clientSnap = getDesktopNotificationSnapshot()
      expect(clientSnap).toEqual({ permission: "unsupported", enabled: false })
      expect(getDesktopNotificationSnapshot()).toBe(clientSnap)
      expect(isDesktopNotificationsActive()).toBe(false)

      const toggled = await toggleDesktopNotificationsFromGesture()
      expect(toggled).toEqual({ permission: "unsupported", enabled: false })
    } finally {
      if (original !== undefined) {
        ;(window as unknown as Record<string, unknown>).Notification = original
      }
    }
  })

  it("requests permission when `default` and enables storage when granted", async () => {
    const { requestPermission } = stubNotification("default", "granted")
    const listener = vi.fn()
    const unsub = subscribeDesktopNotificationPref(listener)

    expect(getDesktopNotificationSnapshot()).toEqual({ permission: "default", enabled: false })
    expect(isDesktopNotificationsActive()).toBe(false)

    const next = await toggleDesktopNotificationsFromGesture()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(next).toEqual({ permission: "granted", enabled: true })
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY)).toBe("true")
    expect(isDesktopNotificationsActive()).toBe(true)
    expect(listener).toHaveBeenCalled()

    unsub()
  })

  it("does not enable storage when permission request resolves to `denied`", async () => {
    const { requestPermission } = stubNotification("default", "denied")
    const next = await toggleDesktopNotificationsFromGesture()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(next).toEqual({ permission: "denied", enabled: false })
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY)).toBeNull()
    expect(isDesktopNotificationsActive()).toBe(false)

    // Subsequent clicks while denied are a no-op
    const again = await toggleDesktopNotificationsFromGesture()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(again).toEqual({ permission: "denied", enabled: false })
  })

  it("toggles enabled flag on and off when permission is already `granted` and persists in localStorage", async () => {
    stubNotification("granted")
    expect(getDesktopNotificationSnapshot()).toEqual({ permission: "granted", enabled: false })

    const on = await toggleDesktopNotificationsFromGesture()
    expect(on).toEqual({ permission: "granted", enabled: true })
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY)).toBe("true")
    expect(isDesktopNotificationsActive()).toBe(true)

    const off = await toggleDesktopNotificationsFromGesture()
    expect(off).toEqual({ permission: "granted", enabled: false })
    expect(window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY)).toBe("false")
    expect(isDesktopNotificationsActive()).toBe(false)

    setDesktopNotificationsEnabled(true)
    expect(isDesktopNotificationsActive()).toBe(true)
  })
})
