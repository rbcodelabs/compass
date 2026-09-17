import { useCallback, useSyncExternalStore } from "react"

/**
 * Subscribe to a CSS media query.
 *
 * Deliberately separate from `hooks/use-mobile.ts` rather than a
 * generalization of it: that hook is load-bearing for
 * `components/ui/sidebar.tsx` and is pinned by
 * `__tests__/components/sidebar.test.tsx`. Widening its signature to serve a
 * second caller would put the sidebar's behaviour at risk for no benefit. This
 * mirrors its `useSyncExternalStore` shape instead.
 *
 * ## `serverSnapshot` is the interesting parameter
 *
 * There is no media query on the server, so the caller has to say what to
 * assume — and the honest answer is not always `false`. The pinned detail
 * panel passes its *pin preference*: a user whose cookie says "pinned" is
 * assumed to be on a wide viewport, so the server renders the pinned column
 * and hydration agrees with it. Assuming `false` there would render the modal
 * overlay first and swap it for the column one frame after hydration — a
 * visible flash of a backdrop on every single page load.
 *
 * That assumption is only safe because the thing it gates is *also* CSS-gated
 * (`hidden lg:flex`), so a wrong guess on a narrow viewport paints nothing
 * rather than painting something illegal. React then corrects the value on the
 * first post-hydration check. A caller without that CSS backstop should pass
 * `false` and accept the swap.
 */
export function useMediaQuery(query: string, serverSnapshot: boolean): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => undefined
      }
      const list = window.matchMedia(query)
      list.addEventListener("change", onStoreChange)
      return () => list.removeEventListener("change", onStoreChange)
    },
    [query]
  )

  const getSnapshot = useCallback(() => {
    // jsdom and older Safari can both leave matchMedia undefined; fall back to
    // the caller's declared assumption rather than throwing during render.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return serverSnapshot
    }
    return window.matchMedia(query).matches
  }, [query, serverSnapshot])

  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
