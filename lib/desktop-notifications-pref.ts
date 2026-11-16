/**
 * Per-browser preference for desktop `window.Notification` alerts when Compass
 * is open in an unfocused/background tab. Stored in `localStorage` because
 * browser notification permission is per-origin/per-device rather than an
 * account-wide database setting.
 */
export const DESKTOP_NOTIFICATIONS_STORAGE_KEY = "compass:desktop-notifications-enabled"

export type DesktopNotificationState = {
  permission: NotificationPermission | "unsupported"
  enabled: boolean
}

const SERVER_SNAPSHOT: DesktopNotificationState = {
  permission: "unsupported",
  enabled: false,
}

let cachedSnapshot: DesktopNotificationState = SERVER_SNAPSHOT

type Listener = () => void
const listeners = new Set<Listener>()
let windowListenersAttached = false

function readPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window) || !window.Notification) {
    return "unsupported"
  }
  const perm = window.Notification.permission
  if (perm === "granted" || perm === "denied" || perm === "default") return perm
  return "unsupported"
}

function readEnabledFlag(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function writeEnabledFlag(enabled: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, enabled ? "true" : "false")
  } catch {
    // Restricted storage environment (e.g. strict privacy mode); best-effort.
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

function handleExternalChange(event?: Event): void {
  if (
    event &&
    "key" in event &&
    (event as StorageEvent).key !== null &&
    (event as StorageEvent).key !== DESKTOP_NOTIFICATIONS_STORAGE_KEY
  ) {
    return
  }
  emit()
}

function attachWindowListeners(): void {
  if (windowListenersAttached || typeof window === "undefined") return
  windowListenersAttached = true
  window.addEventListener("storage", handleExternalChange)
  window.addEventListener("focus", emit)
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", emit)
  }
}

function detachWindowListeners(): void {
  if (!windowListenersAttached || typeof window === "undefined") return
  windowListenersAttached = false
  window.removeEventListener("storage", handleExternalChange)
  window.removeEventListener("focus", emit)
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", emit)
  }
}

export function subscribeDesktopNotificationPref(listener: Listener): () => void {
  listeners.add(listener)
  attachWindowListeners()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) detachWindowListeners()
  }
}

export function getDesktopNotificationSnapshot(): DesktopNotificationState {
  const permission = readPermission()
  const enabled = readEnabledFlag()
  if (cachedSnapshot.permission === permission && cachedSnapshot.enabled === enabled) {
    return cachedSnapshot
  }
  cachedSnapshot = { permission, enabled }
  return cachedSnapshot
}

export function getDesktopNotificationServerSnapshot(): DesktopNotificationState {
  return SERVER_SNAPSHOT
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  writeEnabledFlag(enabled)
  emit()
}

export async function toggleDesktopNotificationsFromGesture(): Promise<DesktopNotificationState> {
  const current = getDesktopNotificationSnapshot()
  if (current.permission === "unsupported" || current.permission === "denied") {
    return current
  }
  if (current.permission === "default") {
    let result: NotificationPermission = "default"
    try {
      result = await window.Notification.requestPermission()
    } catch {
      result = readPermission() === "unsupported" ? "default" : (readPermission() as NotificationPermission)
    }
    if (result === "granted") {
      writeEnabledFlag(true)
    }
    emit()
    return getDesktopNotificationSnapshot()
  }
  setDesktopNotificationsEnabled(!current.enabled)
  return getDesktopNotificationSnapshot()
}

export function isDesktopNotificationsActive(): boolean {
  const state = getDesktopNotificationSnapshot()
  return state.permission === "granted" && state.enabled
}
