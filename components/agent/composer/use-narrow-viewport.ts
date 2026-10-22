"use client"

import { useSyncExternalStore } from "react"

/** Below Tailwind's `sm`: the composer's pickers become bottom sheets with touch-sized rows. */
const NARROW_QUERY = "(max-width: 639px)"

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  const list = window.matchMedia(NARROW_QUERY)
  list.addEventListener("change", onChange)
  return () => list.removeEventListener("change", onChange)
}

function getSnapshot() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false
}

/** True on phone-width viewports. False on the server and wherever matchMedia is unavailable (the popover is the safe default). */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
