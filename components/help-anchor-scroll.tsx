"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"

/**
 * Scrolls to the element matching `window.location.hash` whenever the route
 * changes. Needed because navigating here via client-side transition (e.g.
 * from the ⌘K workspace search palette's Help results, which link straight
 * to `/help/<slug>#<anchor>`) does not reliably reproduce the browser's
 * native anchor-scroll behavior the way a fresh full-page load does — the
 * palette's `router.push` swaps the route but leaves scroll position
 * untouched, landing the reader on an unrelated section of the doc.
 */
export function HelpAnchorScroll() {
  const pathname = usePathname()

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (!hash) return

    const scrollToTarget = () => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" })
    }

    scrollToTarget()

    // Doc images (screenshots) have no reserved dimensions, so they shift
    // the layout as they finish loading after the initial scroll — leaving
    // the anchored heading scrolled out of view again. Re-run the scroll
    // whenever a still-loading image in the doc body settles.
    const pendingImages = Array.from(document.querySelectorAll<HTMLImageElement>(".docs-content img")).filter(
      (img) => !img.complete,
    )
    pendingImages.forEach((img) => img.addEventListener("load", scrollToTarget))

    return () => {
      pendingImages.forEach((img) => img.removeEventListener("load", scrollToTarget))
    }
  }, [pathname])

  return null
}
