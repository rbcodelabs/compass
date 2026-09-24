"use client"
import { Analytics } from "@vercel/analytics/react"
import { safeBrowserPageUrl } from "@/lib/analytics/activity-policy"

/** Not mounted until the browser referrer-policy decision is approved. */
export function ProductAnalytics() {
  return <Analytics mode="production" beforeSend={event => {
    try {
      // Fail closed if a caller mounts this without the required policy.
      if (document.querySelector<HTMLMetaElement>('meta[name="referrer"]')?.content !== "no-referrer") return null
      const url = safeBrowserPageUrl(event.url, document.referrer, localStorage.getItem("__va_attribution"), Boolean(document.querySelector("[data-flag-values]")))
      return url ? { ...event, url } : null
    } catch { return null }
  }} />
}
