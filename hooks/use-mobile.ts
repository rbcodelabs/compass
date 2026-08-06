import { useSyncExternalStore } from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined
      const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
      query.addEventListener("change", onStoreChange)
      return () => query.removeEventListener("change", onStoreChange)
    },
    () =>
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
        : false,
    () => false
  )
}
