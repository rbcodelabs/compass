"use client"

import { useSyncExternalStore } from "react"
import { Bell, BellOff, BellRing } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  getDesktopNotificationServerSnapshot,
  getDesktopNotificationSnapshot,
  subscribeDesktopNotificationPref,
  toggleDesktopNotificationsFromGesture,
} from "@/lib/desktop-notifications-pref"

export function useDesktopNotificationPref() {
  return useSyncExternalStore(
    subscribeDesktopNotificationPref,
    getDesktopNotificationSnapshot,
    getDesktopNotificationServerSnapshot,
  )
}

/**
 * Per-browser opt-in toggle for background `window.Notification` alerts.
 * Hidden during SSR and in environments without the Web Notifications API so
 * hydration never mismatches.
 */
export function DesktopNotificationToggle() {
  const { permission, enabled } = useDesktopNotificationPref()

  if (permission === "unsupported") {
    return null
  }

  if (permission === "denied") {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        data-testid="desktop-notifications-toggle"
        title="Notifications are blocked for this site in your browser settings."
      >
        <BellOff aria-hidden="true" />
        {"Desktop alerts blocked"}
      </Button>
    )
  }

  const active = permission === "granted" && enabled

  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={active}
      data-testid="desktop-notifications-toggle"
      onClick={() => {
        void toggleDesktopNotificationsFromGesture()
      }}
    >
      {active ? <BellRing aria-hidden="true" /> : <Bell aria-hidden="true" />}
      {active ? "Desktop alerts: On" : "Desktop alerts: Off"}
    </Button>
  )
}
